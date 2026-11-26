import { expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { advancePipelineV2, type PipelineV2Ports } from './pipeline-v2-execution'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { fixtureSource, pipelineV2AdmissionFixture, v2Mutation } from './pipeline-v2.test-fixture'

it('holds a dirty independent review before dispatch and permits an explicit resume after a clean commit', async () => {
  const store = new PipelineStore(':memory:')
  try {
    const template = pipelineV2TemplateFixture()
    const review = template.stages[2]
    if (review.kind !== 'agent') {
      throw new Error('Expected review agent')
    }
    review.independent = true
    review.evidenceSchema = 'review'
    review.outcomes[1].target = { kind: 'stage', stageId: 'review' }
    template.stages = [review]
    template.entryStageId = 'review'
    store.createV2(pipelineV2AdmissionFixture(template))
    let dirty = true
    const ports: PipelineV2Ports = {
      sourceRevision: async () => fixtureSource,
      reviewCommit: async () => {
        if (dirty) {
          throw new Error('pipeline_review_requires_clean_commit')
        }
        return 'b'.repeat(40)
      },
      settled: async () => false,
      checks: async () => {
        throw new Error('Unexpected checks')
      },
      startInvocation: async (request, _spec, prepared) => {
        expect(request.invocation.reviewCommit).toBe('b'.repeat(40))
        const session = {
          kind: 'structured' as const,
          sessionId: 'fresh-review',
          compatibilityKey: 'c'.repeat(64)
        }
        prepared({ dispatchId: 'review-dispatch', session })
        return { state: 'ready' }
      }
    }
    await advancePipelineV2(store, ports, 'run-1')
    expect(store.getV2('run-1')).toMatchObject({
      state: 'paused',
      reason: 'pipeline_review_requires_clean_commit',
      usedInvocations: 0,
      invocations: []
    })
    dirty = false
    v2Mutation(store, { kind: 'resume' })
    await advancePipelineV2(store, ports, 'run-1')
    expect(store.getV2('run-1')).toMatchObject({
      state: 'running',
      usedInvocations: 1,
      invocations: [
        { state: 'running', dispatchId: 'review-dispatch', reviewCommit: 'b'.repeat(40) }
      ]
    })
  } finally {
    store.close()
  }
})
