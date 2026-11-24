import { afterEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import {
  fixtureSource,
  fixtureSession,
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from './pipeline-v2.test-fixture'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { advancePipelineV2 } from './pipeline-v2-execution'

let store: PipelineStore
afterEach(() => store?.close())
function submitted(blocked = false) {
  const invocationId = 'existing-worker'
  const reserved = v2Mutation(store, {
    kind: 'reserve',
    invocationId,
    purpose: 'stage',
    sourceRevision: fixtureSource
  })
  v2Mutation(store, {
    kind: 'bind',
    invocationId,
    dispatchId: 'existing-dispatch',
    session: fixtureSession
  })
  v2Mutation(store, {
    kind: 'submit',
    invocationId,
    dispatchId: 'existing-dispatch',
    inputRevision: reserved.invocations[0].inputRevision,
    sourceRevision: fixtureSource,
    result: blocked
      ? { status: 'blocked', summary: 'Need credentials', reason: 'Owner credentials required' }
      : {
          status: 'result',
          outcomeId: 'done',
          summary: 'Plan complete',
          evidence: {
            stage: 'generic',
            statement: 'Plan is ready',
            rationale: 'Requirements studied',
            files: []
          }
        }
  })
  return invocationId
}

it('reconciles submitted evidence into a pause without dispatching the next stage', async () => {
  store = new PipelineStore(':memory:')
  store.createV2(pipelineV2AdmissionFixture())
  const invocationId = submitted()
  v2Mutation(store, { kind: 'uncertain', reason: 'pipeline_launch_unconfirmed' })
  const reconciled = v2Mutation(store, { kind: 'reconcile', invocationId })
  expect(reconciled).toMatchObject({ state: 'paused', stageId: 'implement', usedInvocations: 1 })
  expect(reconciled.activeInvocationId).toBeUndefined()
  await advancePipelineV2(
    store,
    {
      sourceRevision: async () => fixtureSource,
      reviewCommit: async () => fixtureSource,
      settled: async () => true,
      startInvocation: async () => {
        throw new Error('Unexpected next launch')
      },
      checks: async () => {
        throw new Error('Unexpected next check')
      }
    },
    'run-1'
  )
  expect(store.getV2('run-1')).toEqual(reconciled)
})

it('retains a blocked visit and consumes return limits when explicitly retrying it', () => {
  store = new PipelineStore(':memory:')
  const template = pipelineV2TemplateFixture()
  template.stages[0].maxReentries = 0
  store.createV2(pipelineV2AdmissionFixture(template))
  const invocationId = submitted(true)
  v2Mutation(store, { kind: 'settle', invocationId })
  const limited = v2Mutation(store, { kind: 'retry', sourceRevision: fixtureSource })
  expect(limited).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'budget',
    usedInvocations: 1
  })
  expect(limited.visits.map((visit) => visit.state)).toEqual(['blocked'])
  const extended = v2Mutation(store, { kind: 'extend_budget', stageId: 'plan', maxReentries: 1 })
  expect(extended).toMatchObject({ state: 'running', stageId: 'plan', usedInvocations: 1 })
  expect(extended.visits.map((visit) => visit.state)).toEqual(['blocked', 'pending'])
})

it('does not allow retry to bypass an owner decision or erase unverified session input', () => {
  store = new PipelineStore(':memory:')
  store.createV2(pipelineV2AdmissionFixture(gatedV2Template()))
  const gate = settleV2Stage(store)
  expect(() => v2Mutation(store, { kind: 'retry', sourceRevision: fixtureSource })).toThrow(
    'pipeline_owner_decision_required'
  )
  v2Mutation(store, {
    kind: 'invalidate_candidate',
    sessionId: fixtureSession.sessionId,
    receiptId: 'raw-input'
  })
  expect(() => v2Mutation(store, { kind: 'retry', sourceRevision: fixtureSource })).toThrow(
    'pipeline_owner_decision_required'
  )
  expect(store.getV2('run-1').pendingDecision).toEqual(gate.pendingDecision)
})
