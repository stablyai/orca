import { JournalMailDisplayRetention } from './journal-mail-display-retention'
import type Database from '../../sqlite/sync-database'
import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import {
  mailDisplayAttachmentKey,
  readMailDisplayReport,
  type MailDisplayAttachment,
  type MailDisplayProjection
} from '../../../shared/agent-session/mail-display-report'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalReducerState } from './journal-reducer'

export function ensureJournalMailDisplayReports(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_mail_display_reports (
    session_id TEXT NOT NULL, mail_message_id TEXT NOT NULL,
    mail_run_id TEXT NOT NULL, mail_from TEXT NOT NULL, mail_mailbox TEXT NOT NULL,
    report_json TEXT NOT NULL, PRIMARY KEY (session_id, mail_message_id)
  )`)
}

export function mailReferences(
  body: Pick<AgentJournalMessageItem, 'from'> | null | undefined
): Omit<MailDisplayAttachment, 'report'>[] {
  const mail = orchestrationMailNotice(body?.from)
  return mail
    ? mail.messages.map(({ messageId, runId, from }) => ({
        mailbox: mail.mailbox,
        messageId,
        runId,
        from
      }))
    : []
}

/** One immutable-fact map per open journal; only the selected response's references are projected. */
export class JournalMailDisplayReports {
  private readonly retention = new JournalMailDisplayRetention()
  private readable = false
  private readonly reports = new Map<string, MailDisplayAttachment>()
  constructor(private readonly sessionId: string) {}

  load(db: Database.Database): void {
    this.reports.clear()
    this.readable = false
    let rows
    try {
      rows = db
        .prepare(
          `SELECT mail_message_id, mail_run_id, mail_from, mail_mailbox, report_json FROM journal_mail_display_reports WHERE session_id = ?`
        )
        .all(this.sessionId)
    } catch {
      return
    }
    this.readable = true
    for (const row of rows) {
      const report = readMailDisplayReport(row.report_json)
      if (
        report &&
        typeof row.mail_message_id === 'string' &&
        typeof row.mail_run_id === 'string' &&
        typeof row.mail_from === 'string' &&
        typeof row.mail_mailbox === 'string'
      ) {
        const fact = {
          messageId: row.mail_message_id,
          runId: row.mail_run_id,
          from: row.mail_from,
          mailbox: row.mail_mailbox,
          report
        }
        this.reports.set(mailDisplayAttachmentKey(fact), fact)
      }
    }
  }

  rebuildOwners(
    state: JournalReducerState,
    legacy: readonly { messageId: string; body: AgentJournalMessageItem }[] = []
  ): void {
    this.retention.rebuild(state, legacy)
  }

  receipt(
    body: AgentJournalMessageItem,
    attachments: readonly MailDisplayAttachment[]
  ): JournalOperationReceipt {
    const refs = new Set(mailReferences(body).map(mailDisplayAttachmentKey))
    const facts = attachments.flatMap((fact) => {
      const report = readMailDisplayReport(fact.report)
      return report && refs.has(mailDisplayAttachmentKey(fact)) ? [{ ...fact, report }] : []
    })
    const inserted: MailDisplayAttachment[] = []
    return {
      write: (db) => {
        if (!this.readable) {
          return
        }
        for (const fact of facts) {
          const result = db
            .prepare(`INSERT OR IGNORE INTO journal_mail_display_reports VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
              this.sessionId,
              fact.messageId,
              fact.runId,
              fact.from,
              fact.mailbox,
              JSON.stringify(fact.report)
            )
          if (result.changes) {
            inserted.push(fact)
          }
        }
      },
      committed: () =>
        inserted.forEach((fact) => this.reports.set(mailDisplayAttachmentKey(fact), fact))
    }
  }

  project<
    T extends { itemId: string; body: { kind: string; from?: AgentJournalMessageItem['from'] } }
  >(items: readonly T[]): MailDisplayProjection | undefined {
    const entries: (MailDisplayAttachment & { itemId: string })[] = []
    for (const item of items) {
      if (item.body.kind !== 'message') {
        continue
      }
      for (const ref of mailReferences(item.body)) {
        const fact = this.reports.get(mailDisplayAttachmentKey(ref))
        if (fact) {
          entries.push({ ...fact, itemId: item.itemId })
        }
      }
    }
    return entries.length ? { version: 1, entries } : undefined
  }

  retire(db: Database.Database): () => void {
    if (!this.readable) {
      return () => undefined
    }
    const removed: string[] = []
    for (const [key, fact] of this.reports) {
      if (!this.retention.has(key)) {
        db.prepare(
          'DELETE FROM journal_mail_display_reports WHERE session_id = ? AND mail_message_id = ?'
        ).run(this.sessionId, fact.messageId)
        removed.push(key)
      }
    }
    return () => removed.forEach((key) => this.reports.delete(key))
  }

  transition(db: Database.Database, state: JournalReducerState): () => void {
    const staged = this.retention.stage(state)
    for (const key of staged.retired) {
      const fact = this.reports.get(key)
      if (fact) {
        db.prepare(
          'DELETE FROM journal_mail_display_reports WHERE session_id = ? AND mail_message_id = ?'
        ).run(this.sessionId, fact.messageId)
      }
    }
    return () => {
      staged.committed()
      for (const key of staged.retired) {
        this.reports.delete(key)
      }
    }
  }

  close(): void {
    this.reports.clear()
    this.retention.clear()
    this.readable = false
  }
}
