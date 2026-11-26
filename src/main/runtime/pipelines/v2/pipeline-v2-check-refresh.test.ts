import { afterEach, beforeEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2ReviewedFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { advancePipelineV2 } from './pipeline-v2-execution'
import { fixtureSource, pipelineV2AdmissionFixture, v2Mutation } from './pipeline-v2.test-fixture'

let store: PipelineStore
let source: string
beforeEach(() => {
  store = new PipelineStore(':memory:')
  source = fixtureSource
})
afterEach(() => store.close())
const ports = {
  sourceRevision: async () => source,
  reviewCommit: async () => 'b'.repeat(40),
  settled: async () => true,
  startInvocation: async () => {
    throw new Error('Unexpected agent launch')
  },
  checks: async () => ({
    category: 'passed' as const,
    body: 'Unit checks passed',
    results: [{ id: 'unit', code: 0, timedOut: false, outputTruncated: false }]
  })
}
async function gatedChecks(maxReentries = 2) {
  const template = pipelineV2ReviewedFixture()
  template.entryStageId = 'checks'
  const checks = template.stages.find((stage) => stage.id === 'checks')!
  template.stages = [checks]
  template.completionPolicy = { kind: 'workflow_complete' }
  checks.outcomes = checks.outcomes.map((outcome) => ({ ...outcome, target: { kind: 'finish' } }))
  checks.ownerGate.enabled = true
  checks.maxReentries = maxReentries
  store.createV2(pipelineV2AdmissionFixture(template))
  await advancePipelineV2(store, ports, 'run-1')
  return store.getV2('run-1')
}
it('explicitly rechecks changed source without accepting or erasing the displayed checks candidate', async () => {
  const before = await gatedChecks()
  const oldCandidate = before.candidates[0]
  source = 'd'.repeat(64)
  const request = {
    requestId: 'refresh-checks',
    expectedRevision: before.revision,
    expectedInstanceId: 'instance-1',
    command: { kind: 'revalidate', sourceRevision: source }
  }
  store.commandV2('run-1', request)
  await advancePipelineV2(store, ports, 'run-1')
  const after = store.getV2('run-1')
  expect(after).toMatchObject({
    state: 'waiting_owner',
    stageId: 'checks',
    sourceRevision: 'd'.repeat(64),
    usedInvocations: 2
  })
  expect(after.candidates[0]).toEqual(oldCandidate)
  expect(after.visits[0]).toMatchObject({ state: 'interrupted', candidateIds: [oldCandidate.id] })
  expect(after.visits[0].acceptedCandidateId).toBeUndefined()
  expect(after.pendingDecision).toMatchObject({
    visitId: 'run-1:visit:2',
    sourceRevision: 'd'.repeat(64)
  })
  expect(after.pendingDecision?.candidateId).not.toBe(oldCandidate.id)
  store.commandV2('run-1', request)
  expect(store.getV2('run-1').pendingDecision).toEqual(after.pendingDecision)
})
it('holds a checks refresh at the configured return budget until the owner extends it', async () => {
  const before = await gatedChecks(0)
  source = 'd'.repeat(64)
  const held = v2Mutation(store, { kind: 'revalidate', sourceRevision: source })
  expect(held).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'budget',
    usedInvocations: 1,
    pendingTransition: { target: { kind: 'stage', stageId: 'checks' } }
  })
  expect(held.pendingDecision).toBeUndefined()
  expect(held.candidates[0]).toEqual(before.candidates[0])
  v2Mutation(store, { kind: 'extend_budget', stageId: 'checks', maxReentries: 1 })
  await advancePipelineV2(store, ports, 'run-1')
  expect(store.getV2('run-1')).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'owner_gate',
    stageId: 'checks',
    usedInvocations: 2
  })
})
