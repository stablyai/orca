import type Database from '../../../sqlite/sync-database'
import type { z } from 'zod'
import {
  PipelineV2DraftReceipt,
  type PipelineV2DraftSaveInput,
  type PipelineV2TemplateProvenance
} from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { pipelineV2SerializedBytes } from '../../../../shared/pipelines/v2/pipeline-v2-values'

export function writePipelineV2Draft(
  db: Database.Database,
  input: z.infer<typeof PipelineV2DraftSaveInput>,
  provenance?: z.infer<typeof PipelineV2TemplateProvenance>
): PipelineV2DraftReceipt {
  if (input.projectId !== input.draft.projectId) {
    throw new Error('pipeline_template_project_mismatch')
  }
  if (pipelineV2SerializedBytes(input.draft) > 256 * 1024) {
    throw new Error('pipeline_definition_budget')
  }
  if (
    db
      .prepare('SELECT id FROM pipeline_template_deleted_drafts_v2 WHERE project_id=? AND id=?')
      .get(input.projectId, input.draft.id)
  ) {
    throw new Error('pipeline_draft_deleted')
  }
  const row = db
    .prepare(
      'SELECT revision,provenance FROM pipeline_template_drafts_v2 WHERE project_id=? AND id=?'
    )
    .get(input.projectId, input.draft.id)
  if (Number(row?.revision ?? 0) !== input.expectedRevision) {
    throw new Error('pipeline_revision_conflict')
  }
  if (
    !row &&
    Number(
      db
        .prepare('SELECT count(*) AS count FROM pipeline_template_drafts_v2 WHERE project_id=?')
        .get(input.projectId)?.count
    ) >= 128
  ) {
    throw new Error('pipeline_draft_limit')
  }
  const revision = input.expectedRevision + 1
  db.prepare(
    'INSERT INTO pipeline_template_drafts_v2 (project_id,id,revision,data,provenance,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,provenance=excluded.provenance,updated_at=excluded.updated_at'
  ).run(
    input.projectId,
    input.draft.id,
    revision,
    JSON.stringify(input.draft),
    provenance
      ? JSON.stringify(provenance)
      : (row?.provenance ?? JSON.stringify({ kind: 'native' })),
    Date.now()
  )
  return PipelineV2DraftReceipt.parse({
    requestId: input.requestId,
    projectId: input.projectId,
    draftId: input.draft.id,
    revision,
    draftDigest: pipelineV2Fingerprint(input.draft)
  })
}
