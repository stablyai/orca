import type { PipelineV2Command } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import type {
  PipelineV2Candidate,
  PipelineV2Invocation,
  PipelineV2Run
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { currentPipelineV2Visit, followPipelineV2Target } from './pipeline-v2-routing'
import { requirePipelineV2StageEvidence } from './pipeline-v2-completion'

function active(run: PipelineV2Run, invocationId: string): PipelineV2Invocation {
  const invocation = run.invocations.find((value) => value.id === invocationId)
  if (!invocation || run.activeInvocationId !== invocation.id) {
    throw new Error('pipeline_invocation_conflict')
  }
  return invocation
}

export function reservePipelineV2Invocation(
  run: PipelineV2Run,
  command: Extract<PipelineV2Command, { kind: 'reserve' }>
): void {
  if (!run.definitionEnabled) {
    throw new Error('pipeline_definition_disabled')
  }
  if (run.activeInvocationId) {
    throw new Error('pipeline_invocation_conflict')
  }
  if (command.purpose === 'stage' && run.state !== 'running') {
    throw new Error('pipeline_not_running')
  }
  const visit = currentPipelineV2Visit(run)
  if (command.purpose === 'stage' && visit.state !== 'pending') {
    throw new Error('pipeline_visit_conflict')
  }
  if (command.purpose !== 'stage') {
    if (run.definition.stages.find((value) => value.id === run.stageId)?.kind !== 'agent') {
      throw new Error('pipeline_discussion_requires_agent_stage')
    }
    if (
      run.state !== 'waiting_owner' ||
      !run.pendingDecision ||
      !command.pin ||
      pipelineV2Fingerprint(command.pin) !== pipelineV2Fingerprint(run.pendingDecision)
    ) {
      throw new Error('pipeline_candidate_conflict')
    }
    if (run.unverifiedSessionInput && command.purpose !== 'synchronize') {
      throw new Error('pipeline_session_sync_required')
    }
    const limit = Math.max(
      run.definition.limits.maxDiscussionTurns,
      ...run.budgetExtensions
        .filter((value) => value.visitId === visit.id)
        .map((value) => value.maxDiscussionTurns ?? 0)
    )
    if (visit.discussionTurns >= limit || visit.discussionTurns >= 64) {
      run.waitReason = 'budget'
      run.reason = 'Visit discussion budget exhausted'
      return
    }
  }
  const limit = Math.max(
    run.definition.limits.maxInvocations,
    ...run.budgetExtensions.map((value) => value.maxInvocations ?? 0)
  )
  if (run.usedInvocations >= limit || run.invocations.length >= 256) {
    run.state = 'waiting_owner'
    run.waitReason = 'budget'
    run.reason = 'Run invocation budget exhausted'
    return
  }
  if (run.invocations.some((value) => value.id === command.invocationId)) {
    throw new Error('pipeline_invocation_conflict')
  }
  if (command.purpose !== 'stage') {
    visit.discussionTurns++
  }
  run.invocations.push({
    id: command.invocationId,
    stageId: run.stageId,
    visitId: visit.id,
    purpose: command.purpose,
    state: 'reserved',
    inputRevision: run.revision,
    sourceRevision: command.sourceRevision,
    discussionRevision: visit.discussionTurns,
    ...(command.message ? { message: command.message } : {}),
    ...(command.clientPayloadDigest ? { clientPayloadDigest: command.clientPayloadDigest } : {}),
    ...(command.purpose === 'synchronize' && run.unverifiedSessionInput
      ? { synchronizationReceiptId: run.unverifiedSessionInput.receiptId }
      : {}),
    ...(command.reviewCommit ? { reviewCommit: command.reviewCommit } : {})
  })
  run.activeInvocationId = command.invocationId
  run.usedInvocations++
  run.sourceRevision = command.sourceRevision
  visit.state = 'running'
}

export function bindPipelineV2Invocation(
  run: PipelineV2Run,
  command: Extract<PipelineV2Command, { kind: 'bind' }>
): void {
  const invocation = active(run, command.invocationId)
  if (invocation.state !== 'reserved') {
    throw new Error('pipeline_invocation_conflict')
  }
  const stage = run.definition.stages.find((value) => value.id === invocation.stageId)!
  if (stage.kind === 'agent') {
    const effective = run.effectiveExecutors[stage.id]
    if (
      !effective ||
      effective.compatibilityKey !== command.session.compatibilityKey ||
      command.session.kind === 'checks'
    ) {
      throw new Error('pipeline_session_conflict')
    }
    if (
      stage.independent &&
      invocation.purpose === 'stage' &&
      run.invocations.some(
        (value) =>
          value.id !== invocation.id &&
          (stage.executor.session.kind === 'fresh' ||
            run.definition.stages.some(
              (other) => other.id === value.stageId && other.kind === 'agent' && !other.independent
            )) &&
          value.session?.sessionId === command.session.sessionId
      )
    ) {
      throw new Error('pipeline_review_not_independent')
    }
    if (invocation.purpose !== 'stage') {
      const candidate = run.candidates.find(
        (value) => value.id === run.pendingDecision?.candidateId
      )
      if (!candidate || candidate.sessionId !== command.session.sessionId) {
        throw new Error('pipeline_session_conflict')
      }
    }
    if (stage.executor.session.kind === 'reuse') {
      const previous = run.sessionGroups[stage.executor.session.groupId]
      if (previous && previous.sessionId !== command.session.sessionId) {
        throw new Error('pipeline_session_conflict')
      }
      run.sessionGroups[stage.executor.session.groupId] = command.session
    }
  } else if (command.session.kind !== 'checks') {
    throw new Error('pipeline_session_conflict')
  }
  invocation.dispatchId = command.dispatchId
  invocation.session = command.session
  invocation.state = 'running'
}

export function submitPipelineV2Invocation(
  run: PipelineV2Run,
  command: Extract<PipelineV2Command, { kind: 'submit' }>
): void {
  const invocation = active(run, command.invocationId)
  if (
    invocation.state !== 'running' ||
    invocation.dispatchId !== command.dispatchId ||
    invocation.inputRevision !== command.inputRevision ||
    !invocation.session
  ) {
    throw new Error('pipeline_dispatch_conflict')
  }
  const stage = run.definition.stages.find((value) => value.id === invocation.stageId)!
  const result = command.result
  requirePipelineV2StageEvidence(run, result)
  if (
    (stage.kind === 'checks' ||
      (stage.kind === 'agent' && (stage.independent || stage.evidenceSchema === 'review'))) &&
    command.sourceRevision !== invocation.sourceRevision
  ) {
    throw new Error('pipeline_source_changed')
  }
  if (
    result.status === 'result' &&
    !stage.outcomes.some((value) => value.id === result.outcomeId)
  ) {
    throw new Error('pipeline_invalid_outcome')
  }
  if (run.candidates.length >= 256) {
    throw new Error('pipeline_artifact_limit')
  }
  const body = {
    visitId: invocation.visitId,
    invocationId: invocation.id,
    dispatchId: command.dispatchId,
    sessionId: invocation.session.sessionId,
    inputRevision: command.inputRevision,
    sourceRevision: command.sourceRevision,
    discussionRevision: invocation.discussionRevision,
    result: command.result,
    summary: command.result.summary
  }
  const digest = pipelineV2Fingerprint(body)
  const candidate: PipelineV2Candidate = { ...body, id: `candidate:${digest}`, digest }
  run.candidates.push(candidate)
  currentPipelineV2Visit(run).candidateIds.push(candidate.id)
  invocation.candidateId = candidate.id
  invocation.state = 'submitted'
  run.sourceRevision = command.sourceRevision
}

export function settlePipelineV2Invocation(
  run: PipelineV2Run,
  command: Extract<PipelineV2Command, { kind: 'settle' }>
): void {
  const invocation = active(run, command.invocationId)
  if (invocation.state !== 'submitted' || !invocation.candidateId) {
    throw new Error('pipeline_stage_evidence_required')
  }
  const candidate = run.candidates.find((value) => value.id === invocation.candidateId)!
  const result = candidate.result
  const visit = currentPipelineV2Visit(run)
  const paused = run.state === 'paused'
  invocation.state = 'settled'
  delete run.activeInvocationId
  if (
    invocation.purpose === 'synchronize' &&
    run.unverifiedSessionInput?.receiptId === invocation.synchronizationReceiptId
  ) {
    delete run.unverifiedSessionInput
  }
  if (result.status === 'blocked') {
    visit.state = 'blocked'
    run.state = paused ? 'paused' : 'waiting_owner'
    run.waitReason = 'blocked'
    run.reason = result.reason
    return
  }
  const stage = run.definition.stages.find((value) => value.id === visit.stageId)!
  const outcome = stage.outcomes.find((value) => value.id === result.outcomeId)!
  if (stage.ownerGate.enabled) {
    visit.state = 'waiting_owner'
    run.pendingDecision = {
      id: `decision:${candidate.digest}`,
      visitId: visit.id,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      sourceRevision: candidate.sourceRevision,
      discussionRevision: candidate.discussionRevision,
      proposedOutcomeId: outcome.id,
      proposedTarget: outcome.target
    }
    run.state = paused ? 'paused' : 'waiting_owner'
    run.waitReason = run.unverifiedSessionInput ? 'session_sync' : 'owner_gate'
    return
  }
  visit.state = 'completed'
  visit.acceptedCandidateId = candidate.id
  followPipelineV2Target(run, outcome.target, { fromVisitId: visit.id, candidateId: candidate.id })
}
