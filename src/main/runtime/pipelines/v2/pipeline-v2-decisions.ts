import type { PipelineV2Command } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import {
  currentPipelineV2Visit,
  followPipelineV2Target,
  pipelineV2ReentryLimit
} from './pipeline-v2-routing'

export function decidePipelineV2Candidate(
  run: PipelineV2Run,
  command: Extract<PipelineV2Command, { kind: 'decide' }>
): void {
  const pending = run.pendingDecision
  if (
    !pending ||
    run.waitReason !== 'owner_gate' ||
    !['waiting_owner', 'paused'].includes(run.state) ||
    run.activeInvocationId ||
    run.unverifiedSessionInput
  ) {
    throw new Error('pipeline_owner_decision_required')
  }
  const { kind: _kind, action: _action, comment: _comment, ...pin } = command
  if (
    pipelineV2Fingerprint(pin) !== pipelineV2Fingerprint(pending) ||
    pin.sourceRevision !== run.sourceRevision
  ) {
    throw new Error('pipeline_candidate_conflict')
  }
  const visit = currentPipelineV2Visit(run)
  const stage = run.definition.stages.find((value) => value.id === visit.stageId)!
  if (command.action === 'rework' && !command.comment?.trim()) {
    throw new Error('pipeline_rework_comment_required')
  }
  delete run.pendingDecision
  delete run.waitReason
  delete run.reason
  visit.state = 'completed'
  if (command.action === 'accept') {
    visit.acceptedCandidateId = pending.candidateId
  }
  followPipelineV2Target(
    run,
    command.action === 'accept'
      ? pending.proposedTarget
      : { kind: 'stage', stageId: stage.ownerGate.reworkTargetStageId },
    {
      fromVisitId: visit.id,
      candidateId: pending.candidateId,
      ...(command.comment ? { comment: command.comment } : {})
    }
  )
}

export function extendPipelineV2Budget(
  run: PipelineV2Run,
  command: Extract<PipelineV2Command, { kind: 'extend_budget' }>
): void {
  if (run.activeInvocationId || !['waiting_owner', 'paused'].includes(run.state)) {
    throw new Error('pipeline_budget_conflict')
  }
  const { kind: _kind, ...extension } = command
  if (
    (command.stageId === undefined) !== (command.maxReentries === undefined) ||
    (command.visitId === undefined) !== (command.maxDiscussionTurns === undefined)
  ) {
    throw new Error('pipeline_budget_conflict')
  }
  if (command.stageId && command.maxReentries! <= pipelineV2ReentryLimit(run, command.stageId)) {
    throw new Error('pipeline_budget_conflict')
  }
  if (command.visitId && !run.visits.some((value) => value.id === command.visitId)) {
    throw new Error('pipeline_visit_missing')
  }
  const discussionLimit = Math.max(
    run.definition.limits.maxDiscussionTurns,
    ...run.budgetExtensions
      .filter((value) => value.visitId === command.visitId)
      .map((value) => value.maxDiscussionTurns ?? 0)
  )
  if (command.maxDiscussionTurns !== undefined && command.maxDiscussionTurns <= discussionLimit) {
    throw new Error('pipeline_budget_conflict')
  }
  const invocationLimit = Math.max(
    run.definition.limits.maxInvocations,
    ...run.budgetExtensions.map((value) => value.maxInvocations ?? 0)
  )
  if (command.maxInvocations !== undefined && command.maxInvocations <= invocationLimit) {
    throw new Error('pipeline_budget_conflict')
  }
  if (
    command.maxReentries === undefined &&
    command.maxDiscussionTurns === undefined &&
    command.maxInvocations === undefined
  ) {
    throw new Error('pipeline_budget_conflict')
  }
  run.budgetExtensions.push(extension)
  if (run.waitReason !== 'budget') {
    return
  }
  if (run.state !== 'paused') {
    run.state = run.pendingDecision ? 'waiting_owner' : 'running'
  }
  delete run.waitReason
  delete run.reason
  if (run.pendingDecision) {
    run.waitReason = run.unverifiedSessionInput ? 'session_sync' : 'owner_gate'
  }
  if (run.pendingTransition) {
    const { target, handoff } = run.pendingTransition
    followPipelineV2Target(run, target, handoff)
  }
}
