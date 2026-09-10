import type { OrchestrationDb } from '../orchestration-db'

export function createDispatchTranscriptTables(db: OrchestrationDb): void {
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_transcript_segments (
      dispatch_id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      predecessor_dispatch_id TEXT,
      execution_host_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      terminal_handle TEXT NOT NULL,
      pane_key TEXT NOT NULL,
      pty_incarnation TEXT NOT NULL,
      process_root_id TEXT,
      start_cursor INTEGER NOT NULL CHECK(start_cursor >= 0),
      end_cursor INTEGER CHECK(end_cursor IS NULL OR end_cursor >= start_cursor),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(predecessor_dispatch_id) REFERENCES dispatch_transcript_segments(dispatch_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_transcript_active_incarnation
      ON dispatch_transcript_segments(
        execution_host_id, workspace_key, terminal_handle, pty_incarnation
      ) WHERE end_cursor IS NULL;
    CREATE INDEX IF NOT EXISTS idx_dispatch_transcript_predecessor
      ON dispatch_transcript_segments(predecessor_dispatch_id);

    CREATE TABLE IF NOT EXISTS dispatch_transcript_entries (
      dispatch_id TEXT NOT NULL,
      cursor INTEGER NOT NULL CHECK(cursor >= 0),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(dispatch_id, cursor),
      FOREIGN KEY(dispatch_id) REFERENCES dispatch_transcript_segments(dispatch_id)
    );

    CREATE TABLE IF NOT EXISTS dispatch_transcript_transfer_receipts (
      request_id TEXT PRIMARY KEY,
      lease_transfer_request_id TEXT NOT NULL UNIQUE,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}
