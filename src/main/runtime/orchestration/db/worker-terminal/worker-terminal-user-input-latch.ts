import { createHash } from 'node:crypto'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { OrchestrationDb } from '../orchestration-db'

function paneIdentity(paneKey: string): string {
  const parsed = parsePaneKey(paneKey)
  // Tab IDs can be reminted without changing the terminal. Keep legacy keys exact.
  const identity = parsed ? `leaf:${parsed.leafId}` : `exact:${paneKey}`
  return createHash('sha256').update(identity).digest('hex')
}

// No transaction: the first input and any existing ownership change commit together.
// Store only a fixed-size identity hash, never the pane credential or input contents.
export function recordWorkerTerminalUserInputStatement(db: OrchestrationDb, paneKey: string): void {
  db.db
    .prepare('INSERT OR IGNORE INTO worker_terminal_user_inputs (pane_identity) VALUES (?)')
    .run(paneIdentity(paneKey))
}

export function hasWorkerTerminalUserInput(db: OrchestrationDb, paneKey: string): boolean {
  return Boolean(
    db.db
      .prepare('SELECT 1 FROM worker_terminal_user_inputs WHERE pane_identity = ?')
      .get(paneIdentity(paneKey))
  )
}
