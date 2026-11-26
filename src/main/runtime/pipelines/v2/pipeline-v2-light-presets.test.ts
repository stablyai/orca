import { expect, it } from 'vitest'
import { lightPipelineV2Preset } from './pipeline-v2-light-presets'
import { compilePipelineV2 } from '../../../../shared/pipelines/v2/pipeline-v2-compiler'

it('compiles editable routes without mandatory review and supports a shared-session reviewed-source preset', () => {
  const single = compilePipelineV2(lightPipelineV2Preset('project-1', 'single'))
  expect(single.stages.map((value) => value.id)).toEqual(['implement'])
  expect(single.stages[0].outcomes[0].target).toEqual({ kind: 'finish' })
  const checks = compilePipelineV2(lightPipelineV2Preset('project-1', 'implement-checks'))
  expect(checks.stages.map((value) => value.id)).toEqual(['implement', 'checks'])
  expect(checks.stages[1].outcomes.map((value) => value.target)).toContainEqual({
    kind: 'stage',
    stageId: 'implement'
  })
  const review = compilePipelineV2(lightPipelineV2Preset('project-1', 'configurable-review'))
  expect(review.completionPolicy).toMatchObject({
    kind: 'reviewed_source',
    reviewRequirements: [
      {
        stageId: 'review',
        acceptedOutcomeIds: ['approved'],
        independent: false,
        freshSession: false
      }
    ]
  })
  expect(review.stages[2]).toMatchObject({
    independent: false,
    executor: { session: { kind: 'reuse', groupId: 'primary' } }
  })
})
