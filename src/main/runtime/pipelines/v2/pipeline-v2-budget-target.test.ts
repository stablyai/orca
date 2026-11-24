import { expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { pipelineV2AdmissionFixture, settleV2Stage, v2Mutation } from './pipeline-v2.test-fixture'
import { pipelineV2Summary } from '../../rpc/methods/pipelines/pipeline-v2-scope'
import { pipelineBudgetExtension } from '../../../../shared/pipelines/v2/pipeline-v2-budget-extension'

it('extends the exhausted return target rather than the stage that requested the return', () => {
  const store = new PipelineStore(':memory:')
  try {
    const template = pipelineV2TemplateFixture()
    template.stages[0].maxReentries = 0
    store.createV2(pipelineV2AdmissionFixture(template))
    settleV2Stage(store)
    settleV2Stage(store)
    settleV2Stage(store, 'changes')
    const shown = pipelineV2Summary(store.getV2('run-1'))
    expect(shown.stageId).toBe('review')
    expect(shown.effectiveLimits.maxReentries).toBe(0)
    const extension = pipelineBudgetExtension(shown, {
      maxInvocations: 128,
      maxDiscussionTurns: 32,
      maxReentries: 1
    })
    expect(extension).toEqual({ stageId: 'plan', maxReentries: 1 })
    const resumed = v2Mutation(store, { kind: 'extend_budget', ...extension })
    expect(resumed).toMatchObject({ state: 'running', stageId: 'plan', usedInvocations: 3 })
  } finally {
    store.close()
  }
})
