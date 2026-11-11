import { journalForkRowBytes } from './journal-fork-workspace'
import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { mapBodyLinks } from '../agent-session-wire/acquisition/structured-agent-session-fork-snapshot'
import { continuedOutsideRecordId } from '../agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import {
  providerTimelineKeyPart,
  providerTimelineTurnKeyPart
} from '../agent-session-timeline/provider-timeline-identity'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import type {
  JournalForkPreparationInput,
  JournalForkPreparationResult
} from './journal-fork-preparation'

export class JournalForkPresentation {
  private phase: 'closure' | 'notices' | 'output' | 'done' = 'closure'
  private after = 0
  private count = 0
  private lastItemId: string | null = null
  private pendingOutput?: {
    rank: number
    mapped: string
    item: JournalReplacementItem
    bytes: number
  }
  private closureParent: { rowid: number; id: string; after: string | null } | undefined
  constructor(
    private readonly db: Database.Database,
    private readonly input: JournalForkPreparationInput
  ) {}
  next(): JournalForkPreparationResult {
    const start = performance.now()
    let units = 0
    let bytes = 0
    const MAX_BYTES = 1024 * 1024
    const budget = () =>
      units < 64 && bytes < MAX_BYTES && (units === 0 || performance.now() - start < 8)
    const account = (row: SqliteRow | string) => {
      units++
      bytes += journalForkRowBytes(row)
    }
    while (budget()) {
      switch (this.phase) {
        case 'closure': {
          if (!this.closureParent) {
            const row = this.db
              .prepare(
                'SELECT rowid,id FROM temp.fork_omitted WHERE processed=0 ORDER BY rowid LIMIT 1'
              )
              .get()
            if (!row) {
              this.phase = 'notices'
              this.after = 0
              continue
            }
            this.closureParent = { rowid: Number(row.rowid), id: String(row.id), after: null }
          }
          const parent = this.closureParent
          const edge =
            parent.after === null
              ? this.db
                  .prepare(
                    'SELECT child FROM temp.fork_edges WHERE parent=? ORDER BY child LIMIT 1'
                  )
                  .get(parent.id)
              : this.db
                  .prepare(
                    'SELECT child FROM temp.fork_edges WHERE parent=? AND child>? ORDER BY child LIMIT 1'
                  )
                  .get(parent.id, parent.after)
          if (edge) {
            this.omit(String(edge.child))
            parent.after = String(edge.child)
            account(edge)
          } else {
            this.db
              .prepare('UPDATE temp.fork_omitted SET processed=1 WHERE rowid=?')
              .run(parent.rowid)
            this.closureParent = undefined
            account(parent.id)
          }
          break
        }
        case 'notices': {
          const anchors = new Map<string, number>()
          let exhausted = true
          for (const row of this.db
            .prepare(`SELECT body.rank,body.item_id,body.lifecycle,body.turn_scope_id,
            header.provider_key,header.member,root.provider_key AS root_provider_key,root.turn_id AS root_turn_id
            FROM temp.fork_bodies body JOIN temp.fork_headers header ON header.rank=body.rank
            LEFT JOIN temp.fork_headers root ON root.item_id=body.turn_scope_id
            WHERE body.rank>? AND NOT EXISTS(SELECT 1 FROM temp.fork_omitted WHERE id=body.item_id)
            ORDER BY body.rank LIMIT ?`)
            .iterate(this.after, 64 - units)) {
            const identity = parseAgentJournalItemKey(String(row.provider_key))!
            const scoped = (...parts: string[]) => JSON.stringify(parts)
            const noticePrefix = continuedOutsideRecordId('')
            if (identity.provider === 'legacy' && identity.recordId.startsWith(noticePrefix)) {
              const anchor = identity.recordId.slice(noticePrefix.length)
              const notice =
                identity.agent === 'codex'
                  ? scoped('codex', anchor)
                  : identity.agent === 'claude'
                    ? scoped('row', anchor)
                    : scoped(identity.agent, identity.sessionId, providerTimelineKeyPart(anchor))
              this.db
                .prepare('UPDATE temp.fork_bodies SET notice=? WHERE rank=?')
                .run(notice, row.rank)
              bytes += Buffer.byteLength(notice)
            } else if (!row.lifecycle) {
              const work = (anchor: string) => {
                anchors.set(anchor, Number(row.rank))
                bytes += Buffer.byteLength(anchor)
              }
              work(scoped('row', String(row.item_id)))
              work(scoped('row', String(row.provider_key)))
              if (this.input.sourceThreadId && row.member !== null) {
                work(scoped('codex', String(row.member)))
              } else if (row.turn_scope_id !== null) {
                const rootIdentity =
                  row.root_provider_key === null
                    ? null
                    : parseAgentJournalItemKey(String(row.root_provider_key))
                const keyPart =
                  row.root_turn_id === null
                    ? null
                    : providerTimelineTurnKeyPart(String(row.root_turn_id))
                if (rootIdentity?.provider === 'legacy' && keyPart !== null) {
                  work(scoped(rootIdentity.agent, rootIdentity.sessionId, keyPart))
                }
              }
            }
            this.after = Number(row.rank)
            account(row)
            if (!budget()) {
              exhausted = false
              break
            }
          }
          if (anchors.size) {
            this.db
              .prepare(`INSERT INTO temp.fork_work(anchor,last_rank)
              SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?) WHERE 1
              ON CONFLICT(anchor) DO UPDATE SET last_rank=MAX(fork_work.last_rank,excluded.last_rank)`)
              .run(JSON.stringify([...anchors]))
          }
          if (exhausted) {
            this.phase = 'output'
            this.after = 0
          }
          break
        }
        case 'output': {
          const page: JournalReplacementItem[] = []
          const ordinal = this.count
          while (budget()) {
            if (!this.pendingOutput) {
              const row = this.retainedRow(this.after, true)
              if (!row) {
                this.phase = 'done'
                break
              }
              const item: AgentJournalRenderItem = JSON.parse(String(row.payload))
              let rewritten = false
              const rewrite = (id: string) => {
                const mapped = String(
                  this.db.prepare('SELECT mapped FROM temp.fork_bodies WHERE item_id=?').get(id)
                    ?.mapped ?? id
                )
                rewritten ||= mapped !== id
                return mapped
              }
              const body = mapBodyLinks(item.body, rewrite)
              const bodyUnchanged = !rewritten
              const identity = parseAgentJournalItemKey(String(row.mapped))!
              const output: JournalReplacementItem = {
                identity,
                body,
                observedAt: item.observedAt,
                ownerFence: 0,
                ...agentJournalLinkageFields(item),
                ...(item.turnScope
                  ? {
                      turnScope:
                        item.turnScope.kind === 'turn'
                          ? { kind: 'turn', turnItemId: rewrite(item.turnScope.turnItemId) }
                          : { ...item.turnScope }
                    }
                  : {})
              }
              this.pendingOutput = {
                rank: Number(row.rank),
                mapped: String(row.mapped),
                item: output,
                bytes: bodyUnchanged
                  ? Number(row.body_bytes) +
                    Buffer.byteLength(JSON.stringify({ ...output, body: null })) -
                    4
                  : Buffer.byteLength(JSON.stringify(output))
              }
            }
            const output = this.pendingOutput
            if (page.length && bytes + output.bytes > MAX_BYTES) {
              break
            }
            page.push(output.item)
            this.after = output.rank
            this.count++
            this.lastItemId = output.mapped
            units++
            bytes += output.bytes
            this.pendingOutput = undefined
          }
          if (page.length) {
            return { kind: 'page', ordinal, items: page, bytes }
          }
          break
        }
        case 'done':
          return { kind: 'complete', count: this.count, lastItemId: this.lastItemId }
      }
    }
    return { kind: 'progress', sourceReleased: true }
  }
  private omit(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO temp.fork_omitted(id) VALUES(?)').run(id)
  }
  private retainedRow(after: number, notices = false): SqliteRow | undefined {
    return this.db
      .prepare(`SELECT body.rank,body.item_id,body.payload,body.mapped,body.body_bytes FROM temp.fork_bodies body
      WHERE rank>? AND NOT EXISTS(SELECT 1 FROM temp.fork_omitted WHERE id=body.item_id)
      ${notices ? 'AND (notice IS NULL OR EXISTS(SELECT 1 FROM temp.fork_work WHERE anchor=body.notice AND last_rank>body.rank))' : ''}
      ORDER BY rank LIMIT 1`)
      .get(after)
  }
}
