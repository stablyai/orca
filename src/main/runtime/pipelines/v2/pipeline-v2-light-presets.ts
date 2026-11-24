import type { PipelineV2Template } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { codingPipelineV2Seed } from './pipeline-v2-seeds'

export function lightPipelineV2Preset(
  projectId: string,
  kind: 'single' | 'implement-checks' | 'configurable-review'
): PipelineV2Template {
  const seed = codingPipelineV2Seed(projectId)
  const implement = seed.stages.find((stage) => stage.id === 'implement')!
  const checks = seed.stages.find((stage) => stage.id === 'checks')!
  const review = seed.stages.find((stage) => stage.id === 'review')!
  if (checks.kind !== 'checks') {
    throw new Error('pipeline_check_requirement')
  }
  implement.instructions =
    'Complete the assigned task, verify the result against its requirements, and explain the evidence. Follow repository checks. Do not merge or deploy.'
  implement.inputs.stageIds = []
  implement.outcomes = [
    {
      id: 'done',
      title: 'Done',
      criterion: 'The assigned work and self-check are complete',
      target: { kind: kind === 'single' ? 'finish' : 'next' }
    }
  ]
  checks.inputs.stageIds = ['implement']
  checks.outcomes = checks.outcomes.map((outcome) => ({
    ...outcome,
    target:
      outcome.id === checks.checkOutcomeMap.failed
        ? { kind: 'stage', stageId: 'implement' }
        : { kind: kind === 'configurable-review' ? 'next' : 'finish' }
  }))
  if (review.kind === 'agent') {
    review.independent = false
    review.executor.session = { kind: 'reuse', groupId: 'primary' }
    review.instructions =
      'Review the current source against the task requirements. Follow the configured session policy; do not claim independence when sharing implementation context. Do not edit source. Report every remaining critical or important finding.'
    review.inputs.stageIds = ['implement', 'checks']
    review.ownerGate.reworkTargetStageId = 'implement'
    review.outcomes = review.outcomes.map((outcome) => ({
      ...outcome,
      target:
        outcome.id === 'approved' ? { kind: 'finish' } : { kind: 'stage', stageId: 'implement' }
    }))
  }
  return {
    ...seed,
    id: kind,
    title: {
      single: 'Single stage with self-check',
      'implement-checks': 'Implementation and checks',
      'configurable-review': 'Configurable review'
    }[kind],
    description:
      'Editable starting point; stages, outcomes, sessions and requirements can be changed before publication.',
    entryStageId: 'implement',
    stages:
      kind === 'single'
        ? [implement]
        : kind === 'implement-checks'
          ? [implement, checks]
          : [implement, checks, review],
    limits: { maxInvocations: 16, maxDiscussionTurns: 8 },
    completionPolicy:
      kind === 'configurable-review' && checks.kind === 'checks'
        ? {
            kind: 'reviewed_source',
            findingPolicy: 'tracked',
            findingDisputes: 'stage_rationale',
            checkRequirements: [{ stageId: 'checks', checkIds: checks.executor.checkIds }],
            reviewRequirements: [
              {
                stageId: 'review',
                acceptedOutcomeIds: ['approved'],
                independent: false,
                freshSession: false
              }
            ],
            repairEntryStageId: 'checks'
          }
        : { kind: 'workflow_complete' }
  }
}
