import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { JournalInputCandidateStorage } from './journal-index-storage'
import type { JournalSqlScope } from './journal-sql-scope'
import type { QueuedMessageRow } from './queued-message-table'

export class JournalSqlCandidates implements JournalInputCandidateStorage {
  private revision = 0
  private walked: { head: QueuedMessageRow; key: string; next: QueuedMessageRow | null }[] = []
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly indexId: string
  ) {}

  private get prefix(): [string, string, string] {
    return [...this.scope.prefix, this.indexId]
  }

  set(card: QueuedMessageRow, candidate: boolean): void {
    this.revision++
    if (!candidate) {
      this.scope.forget(`candidates:${this.indexId}`, card.messageId)
      this.scope.db
        .prepare(`DELETE FROM journal_proj_candidates
          WHERE session_id=? AND epoch=? AND index_id=? AND id=?`)
        .run(...this.prefix, card.messageId)
      return
    }
    this.scope.db
      .prepare(`INSERT OR REPLACE INTO journal_proj_candidates
        (session_id, epoch, index_id, id, position, is_mail, card_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ...this.prefix,
        card.messageId,
        card.position,
        Number(!!orchestrationMailNotice(card.body.from)),
        this.scope.encode(card, `candidates:${this.indexId}`, card.messageId)
      )
  }

  clear(): void {
    this.revision++
    this.walked = []
    this.scope.forget(`candidates:${this.indexId}`)
    this.scope.db
      .prepare('DELETE FROM journal_proj_candidates WHERE session_id=? AND epoch=? AND index_id=?')
      .run(...this.prefix)
  }

  hasMail(): boolean {
    const row = this.scope.db
      .prepare(`SELECT id FROM journal_proj_candidates
        WHERE session_id=? AND epoch=? AND index_id=? AND is_mail LIMIT 1`)
      .get(...this.prefix)
    if (row) {
      this.scope.examined(row)
    }
    return !!row
  }

  *after(card: QueuedMessageRow): Generator<QueuedMessageRow> {
    let position = card.position
    for (;;) {
      // A page includes its last position's complete tie group before applying JS id order.
      const page = this.scope.db
        .prepare(`SELECT position FROM journal_proj_candidates
          WHERE session_id=? AND epoch=? AND index_id=? AND position>?
          ORDER BY position LIMIT 32`)
        .all(...this.prefix, position)
      page.forEach((row) => this.scope.examined(row))
      if (!page.length) {
        return
      }
      const through = Number(page.at(-1)!.position)
      const rows = this.scope.db
        .prepare(`SELECT id, position, card_json FROM journal_proj_candidates
          WHERE session_id=? AND epoch=? AND index_id=? AND position>? AND position<=?`)
        .all(...this.prefix, position, through)
      rows.forEach((row) => this.scope.examined(row))
      rows.sort(
        (a, b) => Number(a.position) - Number(b.position) || (String(a.id) < String(b.id) ? -1 : 1)
      )
      for (const row of rows) {
        yield this.scope.decode<QueuedMessageRow>(row.card_json)
      }
      position = through
    }
  }

  pastHead(
    head: QueuedMessageRow,
    inputs: readonly unknown[],
    walk: () => QueuedMessageRow | null
  ): QueuedMessageRow | null {
    const key = [this.revision, ...inputs].join(':')
    const hit = this.walked.find((entry) => entry.head === head && entry.key === key)
    if (hit) {
      return hit.next
    }
    const next = walk()
    // This memo and its source objects die with the command-scoped view.
    this.walked = [...this.walked, { head, key, next }].slice(-3)
    return next
  }
}
