import type { PipelineV2Candidate } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2VisitSummary } from '../../../../shared/pipelines/v2/pipeline-v2-history-results'
import { sliceAtCodeUnitLimit } from '../../../../shared/text/surrogate-safe-text-slice'

export function pipelineV2ResultPreview(
  candidate: PipelineV2Candidate
): NonNullable<PipelineV2VisitSummary['resultPreview']> {
  const evidence = candidate.result.evidence
  const results = evidence?.stage === 'checks' ? evidence.results : undefined
  const checkResult = !results
    ? undefined
    : results.some((result) => result.timedOut || (result.code !== null && result.code !== 0))
      ? ('failed' as const)
      : results.length === 0 || results.some((result) => result.code === null)
        ? ('unknown' as const)
        : ('passed' as const)
  return {
    candidateId: candidate.id,
    summary: sliceAtCodeUnitLimit(candidate.summary, 320),
    truncated: candidate.summary.length > 320,
    status: candidate.result.status,
    ...(checkResult ? { checkResult } : {}),
    ...(evidence?.stage === 'review' ? { reviewFindings: evidence.findings.length } : {})
  }
}
