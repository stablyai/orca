import type Database from '../../../sqlite/sync-database'
import { PipelineV2TemplateListParams } from '../../../../shared/rpc-contract/pipeline-v2-params'
import {
  PipelineV2Definition,
  PipelineV2Template
} from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import {
  PipelineV2DraftReceipt,
  PipelineV2DraftDeleteReceipt,
  PipelineV2TemplateReceipt,
  PipelineV2Version
} from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { z } from 'zod'
import {
  PipelineV2TemplateListItem,
  PipelineV2TemplatePage
} from '../../../../shared/pipelines/v2/pipeline-v2-library-results'

export function listPipelineV2Templates(db: Database.Database, raw: unknown, latestOnly = false) {
  const input = PipelineV2TemplateListParams.parse(raw)
  const drafts = input.kind === 'drafts'
  const table = drafts ? 'pipeline_template_drafts_v2' : 'pipeline_template_versions_v2'
  const rows = db
    .prepare(
      `SELECT t.rowid,t.* FROM ${table} t WHERE t.project_id=? AND t.rowid>? ${!drafts && input.enabledOnly ? 'AND t.enabled=1' : ''} ${!drafts && latestOnly ? 'AND t.version=(SELECT max(v.version) FROM pipeline_template_versions_v2 v WHERE v.project_id=t.project_id AND v.id=t.id AND v.enabled=1)' : ''} ORDER BY t.rowid LIMIT ?`
    )
    .all(input.projectId, input.cursor, input.limit + 1)
  const templates: PipelineV2TemplateListItem[] = []
  let cursor = input.cursor
  for (const row of rows.slice(0, input.limit)) {
    const definition = drafts
      ? PipelineV2Template.parse(JSON.parse(String(row.data)))
      : PipelineV2Definition.parse(JSON.parse(String(row.definition)))
    const item = PipelineV2TemplateListItem.parse({
      kind: input.kind,
      projectId: input.projectId,
      id: definition.id,
      title: definition.title,
      description: definition.description,
      stageCount: definition.stages.length,
      ...(drafts
        ? { revision: Number(row.revision), updatedAt: Number(row.updated_at) }
        : {
            enabled: row.enabled === 1,
            publishedAt: Number(row.published_at),
            selection: {
              engineVersion: 2,
              projectId: input.projectId,
              id: definition.id,
              version: definition.version,
              digest: row.digest
            }
          })
    })
    if (Buffer.byteLength(JSON.stringify({ templates: [...templates, item] })) > 47000) {
      break
    }
    templates.push(item)
    cursor = Number(row.rowid)
  }
  return PipelineV2TemplatePage.parse({
    projectId: input.projectId,
    templates,
    cursor,
    hasMore: rows.length > templates.length
  })
}
export function replayPipelineV2Template(
  db: Database.Database,
  requestId: string,
  payload: unknown
) {
  const row = db
    .prepare('SELECT digest,result FROM pipeline_template_requests_v2 WHERE request_id=?')
    .get(requestId)
  if (!row) {
    return undefined
  }
  if (row.digest !== pipelineV2Fingerprint(payload)) {
    throw new Error('pipeline_request_conflict')
  }
  return PipelineV2DraftReceipt.parse(JSON.parse(String(row.result)))
}
export function readPipelineV2TemplateReceipt(
  db: Database.Database,
  projectId: string,
  requestId: string
) {
  const row = db
    .prepare('SELECT result FROM pipeline_template_requests_v2 WHERE request_id=?')
    .get(requestId)
  if (!row) {
    return null
  }
  const result = z
    .union([
      PipelineV2DraftReceipt,
      PipelineV2DraftDeleteReceipt,
      PipelineV2TemplateReceipt,
      PipelineV2Version
    ])
    .parse(JSON.parse(String(row.result)))
  const actual =
    'definition' in result
      ? result.definition.projectId
      : 'selection' in result
        ? result.selection.projectId
        : result.projectId
  if (actual !== projectId) {
    throw new Error('pipeline_template_project_mismatch')
  }
  if ('definition' in result) {
    const definition = result.definition
    return PipelineV2TemplateReceipt.parse({
      requestId,
      action: 'published',
      enabled: true,
      selection: {
        engineVersion: 2,
        projectId,
        id: definition.id,
        version: definition.version,
        digest: definition.digest
      }
    })
  }
  return result
}
