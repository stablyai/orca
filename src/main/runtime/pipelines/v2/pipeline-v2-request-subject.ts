import type Database from '../../../sqlite/sync-database'
import type { PipelineV2OwnerRequest } from '../../../../shared/pipelines/v2/pipeline-v2-owner-request-contracts'
import { readPipelineV2TemplateReceipt } from './pipeline-v2-template-queries'
import { sliceAtCodeUnitLimit } from '../../../../shared/text/surrogate-safe-text-slice'

export function pipelineV2RequestSubject(
  db: Database.Database,
  request: PipelineV2OwnerRequest
): string | undefined {
  let row: { title?: unknown } | undefined
  if (request.kind === 'decision') {
    row = db
      .prepare(`SELECT json_extract(stage.value,'$.title') AS title
      FROM pipeline_runs_v2 AS run, json_each(run.data,'$.visits') AS visit, json_each(run.data,'$.definition.stages') AS stage
      WHERE run.id=? AND json_extract(run.data,'$.workspace.projectId')=?
      AND json_extract(visit.value,'$.id')=? AND json_extract(stage.value,'$.id')=json_extract(visit.value,'$.stageId')`)
      .get(request.input.id, request.projectId, request.input.pin.visitId)
  } else if (request.kind === 'budget') {
    row = db
      .prepare(
        "SELECT json_extract(data,'$.definition.title') AS title FROM pipeline_runs_v2 WHERE id=? AND json_extract(data,'$.workspace.projectId')=?"
      )
      .get(request.input.id, request.projectId)
  } else {
    const receipt = readPipelineV2TemplateReceipt(db, request.projectId, request.requestId)
    const selection =
      request.kind === 'disable'
        ? request.input
        : receipt && 'selection' in receipt
          ? receipt.selection
          : undefined
    row = selection
      ? db
          .prepare(
            "SELECT json_extract(definition,'$.title') AS title FROM pipeline_template_versions_v2 WHERE project_id=? AND id=? AND digest=?"
          )
          .get(request.projectId, selection.id, selection.digest)
      : request.kind === 'publish'
        ? db
            .prepare(
              "SELECT json_extract(data,'$.title') AS title FROM pipeline_template_drafts_v2 WHERE project_id=? AND id=? AND revision=?"
            )
            .get(request.projectId, request.input.draftId, request.input.expectedRevision)
        : undefined
  }
  return typeof row?.title === 'string' ? sliceAtCodeUnitLimit(row.title, 120) : undefined
}
