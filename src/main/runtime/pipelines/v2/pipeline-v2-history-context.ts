import type { PipelineStore } from '../pipeline-store'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { assemblePipelineV2Visits } from './pipeline-v2-visit-context'
import { assertPipelineV2ContextBudget } from './pipeline-v2-context-budget'

export function readPipelineV2HistoryContext(
  store: PipelineStore,
  run: PipelineV2Run,
  selector: { visitCursor?: number; limit?: number; artifactId?: string; visitId?: string }
) {
  if (selector.visitCursor !== undefined) {
    return assemblePipelineV2Visits(
      run,
      { visitCursor: selector.visitCursor, limit: selector.limit },
      (visitId) => {
        const record = store.decisionsV2.forVisit(run.id, visitId)
        return record
          ? {
              artifactId: record.id,
              action: record.action,
              outcomeId: record.outcomeId,
              target: record.target,
              candidateId: record.candidateId,
              sessionId: record.sessionId,
              sourceRevision: record.sourceRevision,
              commentPreview: record.comment?.slice(0, 200),
              commentTruncated: (record.comment?.length ?? 0) > 200
            }
          : undefined
      }
    )
  }
  if (!selector.artifactId) {
    return undefined
  }
  const record = store.decisionsV2.artifact(run.id, selector.artifactId)
  if (!record) {
    return undefined
  }
  if (selector.visitId && selector.visitId !== record.visitId) {
    throw new Error('pipeline_artifact_not_found')
  }
  const result = {
    runId: run.id,
    revision: run.revision,
    artifacts: [{ kind: 'owner_decision' as const, ...record }],
    truncated: false,
    omittedArtifacts: [],
    cursor: 0,
    hasMore: false
  }
  assertPipelineV2ContextBudget(result)
  return result
}
