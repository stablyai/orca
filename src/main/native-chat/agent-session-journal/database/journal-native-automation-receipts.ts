import type Database from '../../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalWriterStep } from '../writing/journal-writer-step'
import type { JournalDomainItemCommit } from '../journal-domain-item-write'

/** Writer-local evidence, deliberately absent from item bodies, exports and fork/import inputs. */
export function ensureNativeAutomationReceipts(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_native_automation_receipts (
    session_id TEXT NOT NULL,
    epoch TEXT NOT NULL,
    item_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY(session_id,epoch,item_id),
    FOREIGN KEY(session_id,epoch,item_id) REFERENCES journal_items(session_id,epoch,item_id) ON DELETE CASCADE
  ) WITHOUT ROWID`)
}

export function recordNativeAutomationReceipt(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  step: JournalWriterStep,
  written: JournalDomainItemCommit
): void {
  if (
    step.kind !== 'creation-fact' ||
    step.body.kind !== 'automation-saved' ||
    written.outcome.kind !== 'committed' ||
    !written.outcome.wrote
  ) {
    return
  }
  for (const item of written.items) {
    if (
      item.body.kind === 'automation-saved' &&
      item.itemId === agentJournalItemKey(step.identity)
    ) {
      db.prepare(`INSERT OR REPLACE INTO journal_native_automation_receipts
        (session_id,epoch,item_id,revision) VALUES(?,?,?,?)`).run(
        target.sessionId,
        target.epoch,
        item.itemId,
        item.revision
      )
    }
  }
}
