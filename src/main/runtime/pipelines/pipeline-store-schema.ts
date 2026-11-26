import type Database from '../../sqlite/sync-database'

export function initializeLegacyPipelineSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_runs (id TEXT PRIMARY KEY, instance_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pipeline_requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pipeline_effects (id TEXT PRIMARY KEY, result TEXT);
    CREATE TABLE IF NOT EXISTS pipeline_check_config (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pipeline_creations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, run_id TEXT, data TEXT);`)
  if (
    !db
      .prepare('PRAGMA table_info(pipeline_creations)')
      .all()
      .some((row) => row.name === 'data')
  ) {
    db.exec('ALTER TABLE pipeline_creations ADD COLUMN data TEXT')
  }
}
