import type Database from '../../../sqlite/sync-database'
import type { z } from 'zod'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { PipelineV2OwnerRequest } from '../../../../shared/pipelines/v2/pipeline-v2-owner-request-contracts'
import { readPipelineV2TemplateReceipt } from './pipeline-v2-template-queries'
import { pipelineV2RequestSubject } from './pipeline-v2-request-subject'

type Request = z.infer<typeof PipelineV2OwnerRequest>
export class PipelineV2OwnerRequests {
  constructor(private readonly db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS pipeline_owner_requests_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL)'
    )
    db.prepare('INSERT OR IGNORE INTO pipeline_schema (component,version) VALUES (?,?)').run(
      'pipelines-v2-requests',
      1
    )
  }
  get(projectId: string, requestId: string): Request | null {
    const row = this.db
      .prepare('SELECT data FROM pipeline_owner_requests_v2 WHERE id=? AND project_id=?')
      .get(requestId, projectId)
    return row ? PipelineV2OwnerRequest.parse(JSON.parse(String(row.data))) : null
  }
  request(kind: Request['kind'], input: Record<string, unknown>): Request {
    const request = PipelineV2OwnerRequest.parse({
      kind,
      input,
      requestId: input.requestId,
      projectId: input.projectId,
      state: 'pending',
      createdAt: Date.now()
    })
    if (JSON.stringify(request).length > 16000) {
      throw new Error('pipeline_owner_request_budget')
    }
    const digest = pipelineV2Fingerprint({ kind, input })
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db
        .prepare('SELECT digest,data FROM pipeline_owner_requests_v2 WHERE id=?')
        .get(request.requestId)
      if (previous) {
        if (previous.digest !== digest) {
          throw new Error('pipeline_request_conflict')
        }
        const replay = PipelineV2OwnerRequest.parse(JSON.parse(String(previous.data)))
        this.db.exec('COMMIT')
        return replay
      }
      this.db
        .prepare(
          'INSERT INTO pipeline_owner_requests_v2 (id,project_id,digest,data) VALUES (?,?,?,?)'
        )
        .run(request.requestId, request.projectId, digest, JSON.stringify(request))
      this.db.exec('COMMIT')
      return request
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  list(projectId: string, cursor = 0, limit = 50) {
    const rows = this.db
      .prepare(
        'SELECT rowid,data FROM pipeline_owner_requests_v2 WHERE project_id=? AND rowid>? ORDER BY rowid LIMIT ?'
      )
      .all(projectId, cursor, limit + 1)
    const requests = rows.slice(0, limit).map((row) => {
      const request = PipelineV2OwnerRequest.parse(JSON.parse(String(row.data)))
      const resolved =
        request.kind === 'decision' || request.kind === 'budget'
          ? Boolean(
              this.db
                .prepare(
                  "SELECT request_id FROM pipeline_requests_v2 WHERE request_id=? AND run_id=? AND json_extract(receipt,'$.kind')=?"
                )
                .get(
                  request.requestId,
                  request.input.id,
                  request.kind === 'decision' ? 'decide' : 'extend_budget'
                )
            )
          : Boolean(readPipelineV2TemplateReceipt(this.db, projectId, request.requestId))
      return {
        requestId: request.requestId,
        projectId: request.projectId,
        kind: request.kind,
        createdAt: request.createdAt,
        subject: pipelineV2RequestSubject(this.db, request),
        state: resolved ? ('resolved' as const) : ('pending' as const),
        ...(request.kind === 'decision'
          ? { action: request.input.action }
          : request.kind === 'disable'
            ? { action: request.input.enabled ? ('enable' as const) : ('disable' as const) }
            : {}),
        ...(request.kind === 'decision' || request.kind === 'budget'
          ? { runId: request.input.id }
          : {})
      }
    })
    return {
      requests,
      cursor: Number(rows[Math.min(rows.length, limit) - 1]?.rowid ?? cursor),
      hasMore: rows.length > limit
    }
  }
}
