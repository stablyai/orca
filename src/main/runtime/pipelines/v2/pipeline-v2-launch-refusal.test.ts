import { afterEach, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from '../testing/pipeline-worker-release.test-fixture'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2WorkerPorts } from './pipeline-v2-worker-adapter'
import { advancePipelineV2 } from './pipeline-v2-execution'
import { PipelineController } from '../pipeline-controller'
import { discussPipelineV2BoundSession } from './pipeline-v2-bound-session'
import {
  pipelineV2AgentStage,
  pipelineV2TemplateFixture
} from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import {
  fixtureSession,
  fixtureSource,
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from './pipeline-v2.test-fixture'

const h = createOrchestrationWorkerReleaseHarness()
let store: PipelineStore
afterEach(() => {
  store?.close()
  h.cleanup()
})

it('records oversized task inputs as a definite pre-launch refusal, not an unknown worker', async () => {
  store = new PipelineStore(':memory:')
  const template = pipelineV2TemplateFixture()
  const ids = ['input_a', 'input_b', 'input_c', 'input_d', 'input_e', 'result']
  template.entryStageId = ids[0]
  template.limits.maxInvocations = 10
  template.stages = ids.map((id) => pipelineV2AgentStage(id))
  const target = template.stages.at(-1)!
  target.inputs.stageIds = ids.slice(0, -1)
  target.outcomes[0].target = { kind: 'finish' }
  store.createV2(pipelineV2AdmissionFixture(template))
  for (const id of ids.slice(0, -1)) {
    const invocationId = `seed:${id}`
    v2Mutation(store, {
      kind: 'reserve',
      invocationId,
      purpose: 'stage',
      sourceRevision: fixtureSource
    })
    const invocation = store.getV2('run-1').invocations.at(-1)!
    v2Mutation(store, {
      kind: 'bind',
      invocationId,
      dispatchId: invocationId,
      session: { ...fixtureSession, sessionId: id }
    })
    v2Mutation(store, {
      kind: 'submit',
      invocationId,
      dispatchId: invocationId,
      inputRevision: invocation.inputRevision,
      sourceRevision: fixtureSource,
      result: {
        status: 'result',
        outcomeId: 'done',
        summary: 's'.repeat(10000),
        evidence: {
          stage: 'generic',
          statement: 'Input ready',
          rationale: 'Relevant context',
          files: []
        }
      }
    })
    v2Mutation(store, { kind: 'settle', invocationId })
  }
  await advancePipelineV2(
    store,
    {
      sourceRevision: async () => fixtureSource,
      reviewCommit: async () => fixtureSource,
      settled: async () => false,
      checks: async () => ({ category: 'passed', body: '', results: [] }),
      startInvocation: async () => {
        throw new Error('Oversized input must not start an agent')
      }
    },
    'run-1'
  )
  expect(store.getV2('run-1')).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'interrupted',
    reason: 'pipeline_stage_input_budget',
    usedInvocations: 6
  })
  expect(store.getV2('run-1').activeInvocationId).toBeUndefined()
  expect(store.launchReceiptV2('run-1:invocation:6')).toEqual({
    state: 'not_started',
    reason: 'pipeline_stage_input_budget'
  })
})

it('records a proven pre-launch refusal and permits only a new bounded attempt', async () => {
  h.setup()
  store = new PipelineStore(':memory:')
  store.createV2(pipelineV2AdmissionFixture())
  const workers = pipelineV2WorkerPorts(h.runtime, undefined, () => {
    throw new Error('pipeline_session_executor_changed')
  })
  const ports = {
    ...workers,
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => fixtureSource,
    checks: async () => ({ category: 'passed' as const, body: 'passed', results: [] })
  }
  await advancePipelineV2(store, ports, 'run-1')
  const refused = store.getV2('run-1')
  expect(refused).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'interrupted',
    usedInvocations: 1,
    reason: 'pipeline_session_executor_changed',
    invocations: [{ id: 'run-1:invocation:1', state: 'settled' }]
  })
  expect(refused.activeInvocationId).toBeUndefined()
  expect(refused.invocations[0].dispatchId).toBeUndefined()
  expect(store.launchReceiptV2('run-1:invocation:1')).toEqual({
    state: 'not_started',
    reason: 'pipeline_session_executor_changed'
  })
  await advancePipelineV2(store, ports, 'run-1')
  expect(store.getV2('run-1')).toEqual(refused)
  v2Mutation(store, { kind: 'retry', sourceRevision: fixtureSource })
  await advancePipelineV2(store, ports, 'run-1')
  expect(store.getV2('run-1')).toMatchObject({
    usedInvocations: 2,
    invocations: [
      { id: 'run-1:invocation:1', state: 'settled' },
      { id: 'run-1:invocation:2', state: 'settled' }
    ]
  })
})

it('keeps an ordinary launch exception uncertain rather than certifying no start', async () => {
  store = new PipelineStore(':memory:')
  store.createV2(pipelineV2AdmissionFixture())
  await advancePipelineV2(
    store,
    {
      sourceRevision: async () => fixtureSource,
      reviewCommit: async () => fixtureSource,
      settled: async () => false,
      checks: async () => ({ category: 'passed', body: 'passed', results: [] }),
      startInvocation: async () => {
        throw new Error('pipeline_session_executor_changed')
      }
    },
    'run-1'
  )
  expect(store.getV2('run-1')).toMatchObject({
    state: 'reconciliation_required',
    activeInvocationId: 'run-1:invocation:1'
  })
  expect(store.launchReceiptV2('run-1:invocation:1')).toBeUndefined()
  expect(() => v2Mutation(store, { kind: 'retry', sourceRevision: fixtureSource })).toThrow(
    'pipeline_owner_decision_required'
  )
})

it('returns the same definite rejection for a bound discussion and its replay', async () => {
  h.setup()
  store = new PipelineStore(':memory:')
  store.createV2(pipelineV2AdmissionFixture(gatedV2Template()))
  settleV2Stage(store)
  const workers = pipelineV2WorkerPorts(h.runtime, undefined, () => {
    throw new Error('pipeline_session_executor_changed')
  })
  const ports = {
    ...workers,
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => fixtureSource,
    checks: async () => ({ category: 'passed' as const, body: 'passed', results: [] })
  }
  const service = {
    store,
    v2Ports: ports,
    assertWorkspace: async () => {},
    wake: () => {},
    controller: new PipelineController(
      store,
      {
        ...ports,
        start: async () => {
          throw new Error('Unexpected v1 launch')
        },
        checks: async () => ({ passed: true, body: 'passed' })
      },
      ports
    )
  }
  const input = {
    requestId: 'refused-message',
    sessionId: fixtureSession.sessionId,
    message: 'Explain the rollback',
    hasAttachments: false
  }
  const result = await discussPipelineV2BoundSession(service, input)
  expect(result).toMatchObject({
    handled: true,
    accepted: false,
    rejected: 'pipeline_launch_refused',
    receipt: { state: 'not_started' }
  })
  expect(await discussPipelineV2BoundSession(service, input)).toEqual(result)
  expect(store.getV2('run-1').usedInvocations).toBe(2)
})
