import type {
  PipelineV2Candidate,
  PipelineV2Run
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { pipelineV2ReviewRequirements } from '../../../../shared/pipelines/v2/pipeline-v2-review-policy'
import { pipelineV2FindingLedger } from './pipeline-v2-finding-ledger'
import { pipelineV2FindingId } from '../../../../shared/pipelines/v2/pipeline-v2-findings'

export type PipelineV2CompletionResult = {
  workflowComplete: boolean
  ready: boolean
  currentEvidence: boolean
  reason?: string
  repairEntryStageId?: string
}
function latestAccepted(run: PipelineV2Run, stageId: string, source: string) {
  const visit = run.visits.findLast((value) => value.stageId === stageId)
  const candidate = run.candidates.find((value) => value.id === visit?.acceptedCandidateId)
  const invocation = run.invocations.find((value) => value.id === candidate?.invocationId)
  if (
    !visit ||
    visit.state !== 'completed' ||
    !candidate ||
    !invocation ||
    invocation.state !== 'settled' ||
    !invocation.session ||
    invocation.dispatchId !== candidate.dispatchId ||
    invocation.session.sessionId !== candidate.sessionId ||
    invocation.visitId !== visit.id ||
    candidate.visitId !== visit.id ||
    invocation.sourceRevision !== source ||
    candidate.sourceRevision !== source ||
    candidate.result.status !== 'result'
  ) {
    return undefined
  }
  return { candidate, invocation, result: candidate.result }
}
export function evaluatePipelineV2SourceEvidence(
  run: PipelineV2Run,
  currentSource: string
): PipelineV2CompletionResult {
  const workflowComplete = run.state === 'completed'
  const policy = run.definition.completionPolicy
  if (policy.kind === 'workflow_complete') {
    return { workflowComplete, ready: false, currentEvidence: run.sourceRevision === currentSource }
  }
  const failed = (): PipelineV2CompletionResult => ({
    workflowComplete,
    ready: false,
    currentEvidence: false,
    reason: 'pipeline_source_evidence_stale',
    repairEntryStageId: policy.repairEntryStageId
  })
  for (const requirement of policy.checkRequirements) {
    const accepted = latestAccepted(run, requirement.stageId, currentSource)
    const stage = run.definition.stages.find((value) => value.id === requirement.stageId)
    if (
      !accepted ||
      stage?.kind !== 'checks' ||
      accepted.invocation.session?.kind !== 'checks' ||
      accepted.result.outcomeId !== stage.checkOutcomeMap.passed ||
      accepted.result.evidence.stage !== 'checks'
    ) {
      return failed()
    }
    const results = accepted.result.evidence.results
    if (
      new Set(results.map((value) => value.id)).size !== results.length ||
      requirement.checkIds.some(
        (id) =>
          !results.some(
            (value) =>
              value.id === id && value.code === 0 && !value.timedOut && !value.outputTruncated
          )
      )
    ) {
      return failed()
    }
  }
  for (const requirement of policy.reviewRequirements) {
    const required = pipelineV2ReviewRequirements(requirement)
    const accepted = latestAccepted(run, requirement.stageId, currentSource)
    const stage = run.definition.stages.find((value) => value.id === requirement.stageId)
    if (
      !accepted ||
      stage?.kind !== 'agent' ||
      (required.independent && !stage.independent) ||
      stage.evidenceSchema !== 'review' ||
      (required.freshSession && stage.executor.session.kind !== 'fresh') ||
      !accepted.invocation.reviewCommit ||
      accepted.invocation.session?.kind === 'checks' ||
      !requirement.acceptedOutcomeIds.includes(accepted.result.outcomeId) ||
      accepted.result.evidence.stage !== 'review' ||
      accepted.result.evidence.findings.some((value) => value.severity !== 'minor') ||
      run.invocations.some(
        (value) =>
          (required.freshSession
            ? value.visitId !== accepted.invocation.visitId
            : (required.independent || stage.independent) &&
              run.definition.stages.some(
                (other) =>
                  other.id === value.stageId && other.kind === 'agent' && !other.independent
              )) && value.session?.sessionId === accepted.invocation.session?.sessionId
      )
    ) {
      return failed()
    }
  }
  return { workflowComplete, ready: true, currentEvidence: true }
}

export function evaluatePipelineV2Completion(
  run: PipelineV2Run,
  currentSource: string
): PipelineV2CompletionResult {
  const result = evaluatePipelineV2SourceEvidence(run, currentSource)
  const policy = run.definition.completionPolicy
  if (
    result.ready &&
    policy.kind === 'reviewed_source' &&
    policy.findingPolicy === 'tracked' &&
    pipelineV2FindingLedger(run, currentSource, true).unresolvedImportant > 0
  ) {
    return {
      ...result,
      ready: false,
      reason: 'pipeline_findings_unresolved',
      repairEntryStageId: policy.repairEntryStageId
    }
  }
  return result
}

export function requirePipelineV2StageEvidence(
  run: PipelineV2Run,
  candidate: PipelineV2Candidate['result']
): void {
  if (JSON.stringify(candidate).length > 12000) {
    throw new Error('pipeline_result_budget')
  }
  const known = new Set(
    run.candidates.flatMap((value) =>
      value.result.evidence?.stage === 'review'
        ? value.result.evidence.findings.map(pipelineV2FindingId)
        : []
    )
  )
  if (candidate.evidence?.stage === 'review') {
    const ids = candidate.evidence.findings.map(pipelineV2FindingId)
    if (
      new Set(ids).size !== ids.length ||
      candidate.evidence.findings.some(
        (finding) =>
          finding.id &&
          !known.has(finding.id) &&
          finding.id !== pipelineV2FindingId({ ...finding, id: undefined })
      )
    ) {
      throw new Error('pipeline_finding_identity_invalid')
    }
    ids.forEach((id) => known.add(id))
  }
  const updates = candidate.findingUpdates ?? []
  if (
    new Set(updates.map((value) => value.id)).size !== updates.length ||
    updates.some((value) => !known.has(value.id))
  ) {
    throw new Error('pipeline_finding_identity_invalid')
  }
  if (candidate.status === 'blocked') {
    return
  }
  const stage = run.definition.stages.find((value) => value.id === run.stageId)!
  const expected = stage.kind === 'checks' ? 'checks' : stage.evidenceSchema
  const actual = candidate.evidence.stage
  if (expected === 'changes' ? !['implement', 'fix'].includes(actual) : expected !== actual) {
    throw new Error('pipeline_stage_evidence_mismatch')
  }
}
