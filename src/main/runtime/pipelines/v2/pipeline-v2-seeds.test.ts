import { expect, it } from 'vitest'
import { compilePipelineV2 } from '../../../../shared/pipelines/v2/pipeline-v2-compiler'
import { clonePipelineV1ToV2 } from './pipeline-v2-seeds'

it.each([0, 2])(
  'clones user role choices into a valid separate draft with %i fix cycles',
  (maxFixCycles) => {
    const profile = {
      id: 'owner-profile',
      title: 'Owner workflow',
      version: '7',
      roles: {
        primary: { agent: 'codex', model: 'owner-primary', effort: 'high' as const },
        reviewer: { agent: 'codex', model: 'owner-reviewer', effort: 'low' as const }
      },
      checks: ['owner-unit'],
      maxFixCycles
    }
    const draft = clonePipelineV1ToV2(profile, 'project-1')
    profile.roles.primary.model = 'changed-default'
    const definition = compilePipelineV2(draft)
    const implementation = definition.stages.find((stage) => stage.id === 'implement')!
    const review = definition.stages.find((stage) => stage.id === 'review')!
    expect(implementation.kind === 'agent' && implementation.executor.model).toEqual({
      kind: 'explicit',
      id: 'owner-primary'
    })
    expect(review.kind === 'agent' && review.executor.model).toEqual({
      kind: 'explicit',
      id: 'owner-reviewer'
    })
    expect(review.kind === 'agent' && review.independent).toBe(true)
    expect(definition.completionPolicy).toMatchObject({
      kind: 'reviewed_source',
      checkRequirements: [{ stageId: 'checks', checkIds: ['owner-unit'] }]
    })
  }
)
