import { journalForkRowBytes } from './journal-fork-workspace'
import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  forkDependencies,
  mapBodyLinks
} from '../agent-session-wire/acquisition/structured-agent-session-fork-snapshot'
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

type ForkOutputSource = {
  rank: number
  mapped: string
  bodyBytes: number
  item: AgentJournalRenderItem
}
type ForkOutput = {
  rank: number
  mapped: string
  item: JournalReplacementItem
  bytes: number
}

export class JournalForkPresentation {
  private phase: 'closure' | 'notices' | 'output' | 'done' = 'closure'
  private after = 0
  private count = 0
  private lastItemId: string | null = null
  private pendingOutput?: ForkOutput
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
          const append = (output: ForkOutput) => {
            page.push(output.item)
            this.after = output.rank
            this.count++
            this.lastItemId = output.mapped
            units++
            bytes += output.bytes
          }
          if (this.pendingOutput) {
            append(this.pendingOutput)
            this.pendingOutput = undefined
          }
          if (budget()) {
            const { sources, mappings } = this.outputWindow(64 - units, start)
            if (!sources.length) {
              this.phase = 'done'
            }
            for (const source of sources) {
              const { item } = source
              let rewritten = false
              const rewrite = (id: string) => {
                const mapped = mappings.get(id) ?? id
                rewritten ||= mapped !== id
                return mapped
              }
              const body = mapBodyLinks(item.body, rewrite)
              const bodyUnchanged = !rewritten
              const identity = parseAgentJournalItemKey(source.mapped)!
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
              const formed = {
                rank: source.rank,
                mapped: source.mapped,
                item: output,
                bytes: bodyUnchanged
                  ? source.bodyBytes +
                    Buffer.byteLength(JSON.stringify({ ...output, body: null })) -
                    4
                  : Buffer.byteLength(JSON.stringify(output))
              }
              if (page.length && bytes + formed.bytes > MAX_BYTES) {
                this.pendingOutput = formed
                break
              }
              append(formed)
              if (!budget()) {
                break
              }
            }
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
  private outputWindow(limit: number, start: number) {
    const sources: ForkOutputSource[] = []
    const links = new Set<string>()
    let bytes = 0
    for (const row of this.db
      .prepare(`SELECT body.rank,body.item_id,body.payload,body.mapped,body.body_bytes FROM temp.fork_bodies body
      WHERE rank>? AND NOT EXISTS(SELECT 1 FROM temp.fork_omitted WHERE id=body.item_id)
        AND (notice IS NULL OR EXISTS(SELECT 1 FROM temp.fork_work WHERE anchor=body.notice AND last_rank>body.rank))
      ORDER BY rank LIMIT ?`)
      .iterate(this.after, limit)) {
      const size = journalForkRowBytes(row)
      if (sources.length && bytes + size > 1024 * 1024) {
        break
      }
      const item: AgentJournalRenderItem = JSON.parse(String(row.payload))
      sources.push({
        rank: Number(row.rank),
        mapped: String(row.mapped),
        bodyBytes: Number(row.body_bytes),
        item
      })
      for (const [parent, child] of forkDependencies(item)) {
        if (child === item.itemId) {
          links.add(parent)
        }
      }
      bytes += size
      if (bytes >= 1024 * 1024 || performance.now() - start >= 8) {
        break
      }
    }
    const mappings = new Map<string, string>()
    if (links.size) {
      for (const row of this.db
        .prepare(`SELECT body.item_id,body.mapped FROM json_each(?) wanted
        CROSS JOIN temp.fork_bodies body WHERE body.item_id=wanted.value`)
        .all(JSON.stringify([...links]))) {
        mappings.set(String(row.item_id), String(row.mapped))
      }
    }
    return { sources, mappings }
  }
}
