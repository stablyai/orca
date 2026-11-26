import { afterEach, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from '../testing/pipeline-worker-release.test-fixture'
import { getWorkerTerminalAutoReleaseScheduler } from '../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2WorkerPorts } from './pipeline-v2-worker-adapter'
import {
  gatedV2Template,
  pipelineV2AdmissionFixture,
  fixtureSource,
  v2Mutation
} from './pipeline-v2.test-fixture'

const h = createOrchestrationWorkerReleaseHarness()
afterEach(() => {
  getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
  h.cleanup()
})
it('binds_native_dispatch_before_delivery_and_reuses_that_terminal_for_discussion', async () => {
  h.setup()
  const store = new PipelineStore(':memory:')
  try {
    const admission = pipelineV2AdmissionFixture(gatedV2Template())
    admission.workspace.id = 'repo::worktree'
    admission.effectiveExecutors.plan.surface = 'terminal'
    admission.effectiveExecutors.plan.permissionMode = 'own'
    const run = store.createV2(admission)
    const stage = run.definition.stages[0]
    if (stage.kind !== 'agent') {
      throw new Error('Expected agent stage')
    }
    let observedModel = 'fixture-model-b'
    let launchAllowed = true
    let disableDuringObservation = false
    const ports = pipelineV2WorkerPorts(
      h.runtime,
      async (request) => {
        launchAllowed = !disableDuringObservation
        return { ...request.executor, permissionMode: 'own', model: observedModel }
      },
      () => {
        if (!launchAllowed) {
          throw new Error('pipeline_definition_disabled')
        }
      }
    )
    const start = async (purpose: 'stage' | 'discussion') => {
      const before = store.getV2(run.id)
      const invocationId = purpose
      const reserved = before.invocations.some((value) => value.id === invocationId)
        ? before
        : v2Mutation(store, {
            kind: 'reserve',
            invocationId,
            purpose,
            sourceRevision: fixtureSource,
            ...(purpose === 'discussion'
              ? { pin: before.pendingDecision, message: 'Explain rollback' }
              : {})
          })
      const invocation = reserved.invocations.at(-1)!
      return ports.startInvocation(
        {
          runId: run.id,
          workspace: run.workspace,
          invocation,
          stage,
          executor: run.effectiveExecutors.plan,
          ...(purpose === 'discussion' ? { previousSession: before.invocations[0].session } : {})
        },
        'Provide stage evidence',
        (binding) => {
          v2Mutation(store, { kind: 'bind', invocationId, ...binding })
        }
      )
    }
    const first = await start('stage')
    expect(first).toMatchObject({
      state: 'ready',
      session: { kind: 'terminal', terminalHandle: 'term_worker' }
    })
    expect(first.session?.paneKey).toBe(h.workerPaneKey)
    const invocation = store.getV2(run.id).invocations[0]
    const dispatch = h.db.getDispatchContextById(invocation.dispatchId!)!
    expect(h.db.getRun(dispatch.run_id)?.coordinator_handle).toBeNull()
    v2Mutation(store, {
      kind: 'submit',
      invocationId: invocation.id,
      dispatchId: dispatch.id,
      inputRevision: invocation.inputRevision,
      sourceRevision: fixtureSource,
      result: {
        status: 'result',
        outcomeId: 'done',
        summary: 'Plan ready',
        evidence: { stage: 'generic', statement: 'Plan', rationale: 'Steps documented', files: [] }
      }
    })
    h.settle(dispatch.task_id, dispatch.id, 'succeeded')
    v2Mutation(store, { kind: 'settle', invocationId: invocation.id })
    await expect(start('discussion')).rejects.toThrow('pipeline_session_executor_changed')
    expect(h.db.getActiveDispatchForIdentity('term_worker', h.workerPaneKey)).toBeUndefined()
    observedModel = 'fixture-model-a'
    disableDuringObservation = true
    await expect(start('discussion')).rejects.toThrow('pipeline_definition_disabled')
    expect(h.db.getActiveDispatchForIdentity('term_worker', h.workerPaneKey)).toBeUndefined()
    launchAllowed = true
    disableDuringObservation = false
    const discussion = await start('discussion')
    expect(discussion).toMatchObject({
      state: 'ready',
      session: { sessionId: first.session!.sessionId }
    })
    expect(store.getV2(run.id).state).toBe('waiting_owner')
    expect(h.db.getActiveDispatchForIdentity('term_worker', h.workerPaneKey)?.id).toBe(
      discussion.dispatchId
    )
  } finally {
    store.close()
  }
})
