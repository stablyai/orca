import type Database from '../../../sqlite/sync-database'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'

export function initializePipelineV2Templates(db: Database.Database): void {
  db.exec('SAVEPOINT pipeline_v2_library_schema')
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS pipeline_template_drafts_v2 (project_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, provenance TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS pipeline_template_versions_v2 (project_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL, enabled INTEGER NOT NULL, definition TEXT NOT NULL, provenance TEXT NOT NULL, published_at INTEGER NOT NULL, PRIMARY KEY(project_id,id,version));
      CREATE TABLE IF NOT EXISTS pipeline_template_requests_v2 (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);`)
    db.exec(
      'CREATE TABLE IF NOT EXISTS pipeline_template_deleted_drafts_v2 (project_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(project_id,id))'
    )
    db.prepare(
      'INSERT INTO pipeline_schema (component, version) VALUES (?, ?) ON CONFLICT(component) DO UPDATE SET version=excluded.version'
    ).run('pipelines-v2-library', 2)
    db.exec('RELEASE pipeline_v2_library_schema')
  } catch (error) {
    db.exec('ROLLBACK TO pipeline_v2_library_schema')
    db.exec('RELEASE pipeline_v2_library_schema')
    throw error
  }
}
export function pipelineV2TemplateRequest<T>(
  db: Database.Database,
  requestId: string,
  payload: unknown,
  apply: () => T
): T {
  const digest = pipelineV2Fingerprint(payload)
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db
      .prepare('SELECT digest,result FROM pipeline_template_requests_v2 WHERE request_id = ?')
      .get(requestId)
    if (row) {
      if (row.digest !== digest) {
        throw new Error('pipeline_request_conflict')
      }
      const result: T = JSON.parse(String(row.result))
      db.exec('COMMIT')
      return result
    }
    const result = apply()
    db.prepare(
      'INSERT INTO pipeline_template_requests_v2 (request_id,digest,result) VALUES (?,?,?)'
    ).run(requestId, digest, JSON.stringify(result))
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
