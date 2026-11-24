import type { PipelineV2CompiledTarget } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type {
  PipelineV2Handoff,
  PipelineV2Run,
  PipelineV2Visit
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'

export function currentPipelineV2Visit(run: PipelineV2Run): PipelineV2Visit {
  const visit = run.visits.find((value) => value.id === run.currentVisitId)
  if (!visit) {
    throw new Error('pipeline_visit_missing')
  }
  return visit
}

export function pipelineV2ReentryLimit(run: PipelineV2Run, stageId: string): number {
  const stage = run.definition.stages.find((value) => value.id === stageId)
  if (!stage) {
    throw new Error('pipeline_invalid_target')
  }
  return Math.max(
    stage.maxReentries,
    ...run.budgetExtensions
      .filter((value) => value.stageId === stageId)
      .map((value) => value.maxReentries ?? 0)
  )
}

export function followPipelineV2Target(
  run: PipelineV2Run,
  target: PipelineV2CompiledTarget,
  handoff?: PipelineV2Handoff
): void {
  const paused = run.state === 'paused'
  if (target.kind === 'finish') {
    if (run.definition.completionPolicy.kind === 'reviewed_source') {
      run.pendingTransition = { target, handoff }
      run.waitReason = 'completion'
      return
    }
    run.state = 'completed'
    delete run.pendingTransition
    return
  }
  const visits = run.visits.filter((value) => value.stageId === target.stageId)
  if (visits.length > pipelineV2ReentryLimit(run, target.stageId) || run.visits.length >= 256) {
    run.pendingTransition = { target, handoff }
    run.state = paused ? 'paused' : 'waiting_owner'
    run.waitReason = 'budget'
    run.reason = 'Stage reentry budget exhausted'
    return
  }
  const visit: PipelineV2Visit = {
    id: `${run.id}:visit:${run.visits.length + 1}`,
    stageId: target.stageId,
    attempt: visits.length,
    state: 'pending',
    discussionTurns: 0,
    candidateIds: [],
    ...(handoff ? { handoff } : {})
  }
  run.visits.push(visit)
  run.currentVisitId = visit.id
  run.stageId = target.stageId
  run.state = paused ? 'paused' : 'running'
  delete run.pendingTransition
  delete run.waitReason
  delete run.reason
}
