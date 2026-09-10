export function createMaestroWorkspaceCanvasTablesSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS maestro_workspace_canvas_documents (
      execution_host_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      last_surface_revision INTEGER NOT NULL CHECK (last_surface_revision >= 0),
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (execution_host_id, workspace_key)
    );

    CREATE TABLE IF NOT EXISTS maestro_workspace_canvas_receipts (
      execution_host_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (execution_host_id, workspace_key, idempotency_key)
    );
  `
}
