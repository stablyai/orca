import { afterEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2ReviewedFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { pipelineV2AdmissionFixture, fixtureSource, v2Mutation } from './pipeline-v2.test-fixture'
import { restorePipelineV2 } from './pipeline-v2-recovery'

const stores: PipelineStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close()
  }
})
function fixture() {
  const template = pipelineV2ReviewedFixture()
  const [checks] = template.stages.splice(2, 1)
  template.stages.unshift(checks)
  checks.outcomes[0].target = { kind: 'stage', stageId: 'review' }
  template.entryStageId = 'checks'
  const store = new PipelineStore(':memory:')
  stores.push(store)
  const run = store.createV2(pipelineV2AdmissionFixture(template))
  v2Mutation(store, {
    kind: 'reserve',
    purpose: 'stage',
    invocationId: 'checks-invocation',
    sourceRevision: fixtureSource
  })
  store.claimEffect('pipeline-v2:checks-invocation')
  v2Mutation(store, {
    kind: 'bind',
    invocationId: 'checks-invocation',
    dispatchId: 'checks-invocation',
    session: { kind: 'checks', sessionId: 'runtime-checks', compatibilityKey: run.definitionDigest }
  })
  return store
}
it('restart_with_unknown_check_process_never_reruns_it_or_waits_for_a_nonexistent_dispatch', async () => {
  const store = fixture()
  await restorePipelineV2(store)
  expect(store.getV2('run-1')).toMatchObject({
    state: 'reconciliation_required',
    stageId: 'checks',
    usedInvocations: 1
  })
})
it('restart_settles_checks_only_with_durable_process_receipt_and_submitted_evidence', async () => {
  const store = fixture()
  store.settleEffect('pipeline-v2:checks-invocation', { processComplete: true, category: 'passed' })
  v2Mutation(store, {
    kind: 'submit',
    invocationId: 'checks-invocation',
    dispatchId: 'checks-invocation',
    inputRevision: 0,
    sourceRevision: fixtureSource,
    result: {
      status: 'result',
      outcomeId: 'green',
      summary: 'unit: exit 0',
      evidence: {
        stage: 'checks',
        results: [{ id: 'unit', code: 0, timedOut: false, outputTruncated: false }]
      }
    }
  })
  await restorePipelineV2(store)
  expect(store.getV2('run-1')).toMatchObject({
    state: 'running',
    stageId: 'review',
    usedInvocations: 1
  })
  expect(store.getV2('run-1').activeInvocationId).toBeUndefined()
})
