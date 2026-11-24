import type {
  PipelineV2Run,
  PipelineV2Visit
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import {
  assertPipelineV2ContextBudget,
  pipelineV2ContextPayloadLimit
} from './pipeline-v2-context-budget'
import type {
  PipelineV2VisitSummary,
  PipelineV2VisitPage
} from '../../../../shared/pipelines/v2/pipeline-v2-history-results'
import { pipelineV2ResultPreview } from './pipeline-v2-result-preview'

export function pipelineV2VisitSummary(visit: PipelineV2Visit) {
  return {
    id: visit.id,
    stageId: visit.stageId,
    attempt: visit.attempt,
    state: visit.state,
    discussionTurns: visit.discussionTurns,
    candidateCount: visit.candidateIds.length,
    acceptedCandidateId: visit.acceptedCandidateId,
    latestCandidateId: visit.candidateIds.at(-1),
    hasOwnerComment: Boolean(visit.handoff?.comment)
  }
}
export function assemblePipelineV2Visits(
  run: PipelineV2Run,
  selector: { visitCursor: number; limit?: number },
  decision?: (visitId: string) => PipelineV2VisitSummary['decision']
) {
  const cursor = selector.visitCursor
  const limit = selector.limit ?? 50
  if (
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor > run.visits.length ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    throw new Error('pipeline_cursor_invalid')
  }
  const result: PipelineV2VisitPage = {
    runId: run.id,
    revision: run.revision,
    visits: [],
    cursor,
    hasMore: cursor < run.visits.length
  }
  for (const visit of run.visits.slice(cursor, cursor + limit)) {
    const accepted = run.candidates.find((candidate) => candidate.id === visit.acceptedCandidateId)
    const latest = run.candidates.find((candidate) => candidate.id === visit.candidateIds.at(-1))
    const displayed = accepted ?? latest
    const acceptedOutcomeId =
      accepted?.result.status === 'result' ? accepted.result.outcomeId : undefined
    const outcome = acceptedOutcomeId
      ? run.definition.stages
          .find((stage) => stage.id === visit.stageId)!
          .outcomes.find((outcome) => outcome.id === acceptedOutcomeId)
      : undefined
    const ownerDecision = decision?.(visit.id)
    const invocation = run.invocations.findLast((value) => value.visitId === visit.id)
    const invocations = run.invocations.filter((value) => value.visitId === visit.id)
    const measured = invocations.flatMap((value) =>
      value.responseObservation?.usage ? [value.responseObservation.usage] : []
    )
    const tokenMeasurements = measured.flatMap((value) => (value.tokens ? [value.tokens] : []))
    const tokens =
      measured.length === invocations.length &&
      invocations.length > 0 &&
      tokenMeasurements.length === invocations.length
        ? tokenMeasurements.reduce((total, value) => ({
            uncachedInput: total.uncachedInput + value.uncachedInput,
            cacheReadInput: total.cacheReadInput + value.cacheReadInput,
            cacheWriteInput: total.cacheWriteInput + value.cacheWriteInput,
            output: total.output + value.output,
            reasoningOutputSubset:
              total.reasoningOutputSubset === null || value.reasoningOutputSubset === null
                ? null
                : total.reasoningOutputSubset + value.reasoningOutputSubset
          }))
        : null
    const next = {
      ...pipelineV2VisitSummary(visit),
      executor: run.effectiveExecutors[visit.stageId],
      session: invocation?.session,
      usage: {
        durationMs:
          measured.length === invocations.length &&
          measured.length > 0 &&
          measured.every((value) => value.durationMs !== null)
            ? measured.reduce((total, value) => total + value.durationMs!, 0)
            : null,
        tokens,
        usd: null,
        invocationCount: invocations.length,
        measuredInvocations: measured.length
      },
      ...(displayed
        ? {
            resultPreview: pipelineV2ResultPreview(displayed)
          }
        : {}),
      ...(outcome ? { outcome: { id: outcome.id, target: outcome.target } } : {}),
      ...(latest?.result.status === 'blocked' ? { blockReason: latest.result.reason } : {}),
      ...(ownerDecision ? { decision: ownerDecision } : {})
    }
    if (
      JSON.stringify({ ...result, visits: [...result.visits, next] }).length >
      pipelineV2ContextPayloadLimit
    ) {
      break
    }
    result.visits.push(next)
    result.cursor++
  }
  result.hasMore = result.cursor < run.visits.length
  assertPipelineV2ContextBudget(result)
  return result
}
