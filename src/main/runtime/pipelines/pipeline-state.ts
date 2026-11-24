import type { PipelineCommand, PipelineRun } from '../../../shared/pipelines/pipeline-contracts'

export function transitionPipeline(run: PipelineRun, command: PipelineCommand): PipelineRun {
  const next = structuredClone(run)
  if (command.kind === 'revalidate' || command.kind === 'recheck') {
    if (
      command.kind === 'revalidate'
        ? run.state !== 'ready_for_review'
        : run.state !== 'running' || run.stage !== 'review' || run.active
    ) {
      throw new Error('pipeline_recheck_conflict')
    }
    next.state = 'running'
    next.stage = 'checks'
    next.afterChecks = command.kind === 'revalidate' ? 'docs' : 'review'
    delete next.checkedRevision
    delete next.reviewCommit
    return next
  }
  if (command.kind === 'wait_owner') {
    if (run.active || run.state !== 'running') {
      throw new Error('pipeline_not_running')
    }
    next.state = 'waiting_owner'
    next.reason = command.reason
    return next
  }
  if (command.kind === 'setup_wait') {
    if (
      !run.setupHold ||
      !['waiting_setup', 'paused', 'reconciliation_required'].includes(run.state)
    ) {
      throw new Error('pipeline_setup_conflict')
    }
    next.setupHold = { terminalHandle: command.terminalHandle }
    return next
  }
  if (command.kind === 'setup_ready') {
    if (!run.setupHold) {
      throw new Error('pipeline_setup_conflict')
    }
    delete next.setupHold
    delete next.reason
    next.state = run.state === 'waiting_setup' ? 'running' : 'paused'
    return next
  }
  if (command.kind === 'pause') {
    if (!['running', 'waiting_setup'].includes(run.state)) {
      throw new Error('pipeline_not_running')
    }
    next.state = 'paused'
    if (command.reason) {
      next.reason = command.reason
    }
    return next
  }
  if (command.kind === 'uncertain') {
    next.state = 'reconciliation_required'
    next.reason = command.reason
    return next
  }
  if (command.kind === 'resume') {
    if (!['paused', 'waiting_owner'].includes(run.state) || run.active || run.setupHold) {
      throw new Error('pipeline_reconciliation_required')
    }
    next.state = 'running'
    delete next.reason
    return next
  }
  if (command.kind === 'interrupted') {
    if (!run.active || command.dispatchId !== run.active.dispatchId) {
      throw new Error('pipeline_dispatch_conflict')
    }
    delete next.active
    next.state = 'waiting_owner'
    next.reason = 'Worker settled without stage evidence; inspect it before resuming this stage'
    return next
  }
  if (run.state !== 'running' && !(run.state === 'paused' && command.kind === 'submit')) {
    throw new Error('pipeline_not_running')
  }
  if (command.kind === 'dispatch') {
    if (run.active) {
      throw new Error('pipeline_dispatch_conflict')
    }
    if (run.stage === 'review' && command.sessionId === run.primarySessionId) {
      throw new Error('pipeline_review_not_independent')
    }
    if (run.stage !== 'review' && run.stage !== 'checks') {
      if (run.primarySessionId && command.sessionId !== run.primarySessionId) {
        throw new Error('pipeline_session_conflict')
      }
      next.primarySessionId = command.sessionId
    }
    next.active = {
      dispatchId: command.dispatchId,
      sessionId: command.sessionId,
      inputRevision: run.revision
    }
    if (run.stage === 'review') {
      next.reviewCommit = command.commit
    }
    return next
  }
  if (
    !run.active ||
    command.dispatchId !== run.active.dispatchId ||
    command.inputRevision !== run.active.inputRevision
  ) {
    throw new Error('pipeline_dispatch_conflict')
  }
  if (run.artifacts.length >= 128) {
    throw new Error('pipeline_artifact_limit')
  }
  next.artifacts.push({
    stage: run.stage,
    attempt: run.fixCycles,
    sourceRevision: command.sourceRevision,
    body: command.body,
    verdict: command.verdict,
    evidence: command.evidence,
    ...(run.stage === 'review' ? { commit: run.reviewCommit } : {}),
    dispatchId: run.active.dispatchId,
    sessionId: run.active.sessionId
  })
  delete next.active
  if (command.verdict === 'blocked') {
    next.state = 'waiting_owner'
    return next
  }
  if (command.verdict === 'changes_requested') {
    if (run.stage !== 'review' && run.stage !== 'checks') {
      throw new Error('pipeline_invalid_verdict')
    }
    if (run.fixCycles >= run.profile.maxFixCycles) {
      next.state = 'failed'
      next.reason = 'Fix cycle budget exhausted'
    } else {
      next.fixCycles++
      next.stage = 'fix'
      delete next.checkedRevision
    }
    return next
  }
  switch (run.stage) {
    case 'plan':
      next.stage = 'implement'
      break
    case 'implement':
    case 'fix':
      next.stage = 'checks'
      next.afterChecks = 'docs'
      break
    case 'checks':
      next.checkedRevision = command.sourceRevision
      next.stage = run.afterChecks ?? 'docs'
      break
    case 'docs':
      next.stage = run.checkedRevision === command.sourceRevision ? 'review' : 'checks'
      next.afterChecks = 'review'
      break
    case 'review':
      if (run.checkedRevision !== command.sourceRevision) {
        throw new Error('pipeline_source_changed')
      }
      next.state = 'ready_for_review'
      break
  }
  return next
}
