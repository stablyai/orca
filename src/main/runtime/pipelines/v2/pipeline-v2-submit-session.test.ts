import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  SESSION_X,
  SESSION_Y,
  ADDRESS_X,
  WORKSPACE_X,
  type SessionCallerHarness
} from '../testing/pipeline-session-caller.test-fixture'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { PIPELINE_METHODS } from '../../rpc/methods/pipelines/pipelines'
import { PipelineStore } from '../pipeline-store'
import type { PipelineV2Candidate } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import {
  pipelineV2AdmissionFixture,
  gatedV2Template,
  fixtureSource,
  v2Mutation
} from './pipeline-v2.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
let h: SessionCallerHarness
let store: PipelineStore
let dispatcher: RpcDispatcher
let dispatchId: string
let observedReviewCommit: string
beforeEach(() => {
  observedReviewCommit = 'b'.repeat(40)
  h = createSessionCallerHarness(hostRef)
  store = new PipelineStore(':memory:')
  const admission = pipelineV2AdmissionFixture(gatedV2Template())
  admission.workspace.id = WORKSPACE_X
  store.createV2(admission)
  const nativeRun = h.db.createRun({
    objective: 'Pipeline plan',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const task = h.db.createTask({ spec: 'Plan delivery', runId: nativeRun.id })
  dispatchId = h.db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: ADDRESS_X,
    creator: { kind: 'system' },
    maxDepth: 1
  }).id
  v2Mutation(store, {
    kind: 'reserve',
    invocationId: 'plan-invocation',
    purpose: 'stage',
    sourceRevision: fixtureSource
  })
  v2Mutation(store, {
    kind: 'bind',
    invocationId: 'plan-invocation',
    dispatchId,
    session: { kind: 'structured', sessionId: SESSION_X, compatibilityKey: 'c'.repeat(64) }
  })
  Object.defineProperty(h.runtime, 'pipelineRuntime', {
    value: {
      get store() {
        return store
      },
      assertWorkspace: async () => {},
      v2Ports: {
        sourceRevision: async () => fixtureSource,
        reviewCommit: async () => observedReviewCommit
      },
      wake: () => {}
    }
  })
  dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: PIPELINE_METHODS })
})
afterEach(() => {
  store.close()
  h.close()
  vi.restoreAllMocks()
})
function submit(
  sessionId: string,
  evidence: Extract<PipelineV2Candidate['result'], { status: 'result' }>['evidence'] = {
    stage: 'generic',
    statement: 'Steps available',
    rationale: 'Meets task',
    files: []
  }
) {
  return dispatcher.dispatch(
    orchestrationRequest(
      'pipeline.v2.submit',
      {
        id: 'run-1',
        mutation: {
          requestId: 'stage-result',
          expectedRevision: 2,
          expectedInstanceId: 'instance-1',
          command: {
            kind: 'submit',
            invocationId: 'plan-invocation',
            dispatchId,
            inputRevision: 0,
            sourceRevision: fixtureSource,
            result: {
              status: 'result',
              outcomeId: 'done',
              summary: 'Plan ready',
              evidence
            }
          }
        }
      },
      { sessionId }
    )
  )
}
function replaceStageSchema(kind: 'review' | 'docs') {
  store.close()
  store = new PipelineStore(':memory:')
  const template = gatedV2Template()
  const stage = template.stages[0]
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  stage.evidenceSchema = kind
  stage.independent = kind === 'review'
  stage.outcomes[0].target = { kind: 'finish' }
  template.stages = [stage]
  const admission = pipelineV2AdmissionFixture(template)
  admission.workspace.id = WORKSPACE_X
  store.createV2(admission)
  v2Mutation(store, {
    kind: 'reserve',
    invocationId: 'plan-invocation',
    purpose: 'stage',
    sourceRevision: fixtureSource,
    ...(kind === 'review' ? { reviewCommit: 'b'.repeat(40) } : {})
  })
  v2Mutation(store, {
    kind: 'bind',
    invocationId: 'plan-invocation',
    dispatchId,
    session: { kind: 'structured', sessionId: SESSION_X, compatibilityKey: 'c'.repeat(64) }
  })
}
it('rechecks_the_clean_review_commit_at_the_attested_submit_boundary', async () => {
  replaceStageSchema('review')
  observedReviewCommit = 'c'.repeat(40)
  expect(await submit(SESSION_X, { stage: 'review', findings: [] })).toMatchObject({ ok: false })
  observedReviewCommit = 'b'.repeat(40)
  expect(await submit(SESSION_X, { stage: 'review', findings: [] })).toMatchObject({ ok: true })
})
it('requires_a_source_snapshot_for_documented_files_and_accepts_no_update_rationale', async () => {
  replaceStageSchema('docs')
  expect(await submit(SESSION_X, { stage: 'docs', files: ['README.md'] })).toMatchObject({
    ok: false
  })
  expect(
    await submit(SESSION_X, {
      stage: 'docs',
      files: [],
      rationale: 'The existing documentation already covers the task'
    })
  ).toMatchObject({ ok: true })
})
it('only_the_native_assigned_session_can_submit_v2_and_submission_never_accepts_owner_gate', async () => {
  expect(await submit(SESSION_Y)).toMatchObject({ ok: false })
  const accepted = await submit(SESSION_X)
  if (!accepted.ok) {
    throw new Error(JSON.stringify(accepted.error))
  }
  expect(accepted).toMatchObject({ ok: true, result: { receipt: { kind: 'submit' } } })
  expect(store.getV2('run-1')).toMatchObject({
    stageId: 'plan',
    activeInvocationId: 'plan-invocation'
  })
  expect(store.getV2('run-1').candidates[0].summary).toBe('Plan ready')
})
it('worker_rpc_has_no_owner_resolution_method', async () => {
  const response = await dispatcher.dispatch(
    orchestrationRequest(
      'pipeline.v2.resolveDecision',
      { id: 'run-1', client: { type: 'owner' } },
      { sessionId: SESSION_X }
    )
  )
  expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
  expect(store.getV2('run-1').stageId).toBe('plan')
})
