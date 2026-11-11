import { readJournalDomainDisplayedRow } from './journal-domain-item-display'
import { createJournalForkWorkspace } from './journal-fork-workspace'
import { JournalForkPresentation } from './journal-fork-presentation'
import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { savedRewindKeys } from '../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import {
  omitForkPresentation,
  forkDependencies
} from '../agent-session-wire/acquisition/structured-agent-session-fork-snapshot'
import { sourceThreadTurnMembership } from '../agent-session-wire/rewind/structured-rewind-cut'
import { validateJournalForkSource, type JournalForkSourceProof } from './journal-fork-source-proof'

export type JournalForkPreparationInput = {
  source: JournalForkSourceProof
  sourceThreadId?: string
  childThreadId?: string
}
export type JournalForkPreparationResult =
  | { kind: 'progress'; sourceReleased: boolean }
  | { kind: 'page'; ordinal: number; items: JournalReplacementItem[]; bytes: number }
  | { kind: 'complete'; count: number; lastItemId: string | null }

const MAX_ROWS = 64
const MAX_BYTES = 1024 * 1024

/** One reserved connection, with disk-backed preparation surviving only this finite copy. */
export class JournalForkPreparation {
  private phase: 'submissions' | 'headers' | 'members' | 'kept' | 'capture' = 'submissions'
  private presentation?: JournalForkPresentation
  private sourceOpen = false
  private epoch = ''
  private floor = 0
  private nextItemId: string | null = null
  private position = [0, 0, 0]
  private after = -1
  private end = Number.MAX_SAFE_INTEGER
  private edges?: Generator<readonly [string, string]>

  constructor(
    private readonly db: Database.Database,
    private readonly input: JournalForkPreparationInput
  ) {
    if (db.isTransaction) {
      throw new Error('fork preparation requires an exclusively reserved reader')
    }
    createJournalForkWorkspace(db)
    try {
      db.exec('BEGIN')
      this.sourceOpen = true
      const validated = validateJournalForkSource(db, input.source)
      this.epoch = validated.epoch
      this.nextItemId = validated.boundary.nextItemId
      this.floor = Number(
        db
          .prepare(`SELECT COALESCE(MAX(sequence),0) AS floor FROM journal_items INDEXED BY journal_items_context_clear
        WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1`)
          .get(input.source.sessionId, this.epoch)!.floor
      )
    } catch (error) {
      this.close()
      throw error
    }
  }

  get sourceReleased(): boolean {
    return !this.sourceOpen
  }

  next(): JournalForkPreparationResult {
    if (this.presentation) {
      return this.presentation.next()
    }
    const start = performance.now()
    let units = 0
    let bytes = 0
    const budget = () =>
      units < MAX_ROWS && bytes < MAX_BYTES && (units === 0 || performance.now() - start < 8)
    const account = (row: SqliteRow | string) => {
      units++
      bytes += Buffer.byteLength(typeof row === 'string' ? row : JSON.stringify(row))
    }
    const prefix = [this.input.source.sessionId, this.epoch] as const
    while (budget()) {
      switch (this.phase) {
        case 'submissions': {
          const row = this.db
            .prepare(`SELECT ordinal,payload_json FROM journal_submission_attempts
            WHERE session_id=? AND epoch=? AND current=1 AND ordinal>? AND (?=0 OR accepted_sequence>?) ORDER BY ordinal LIMIT 1`)
            .get(...prefix, this.after, this.floor, this.floor)
          if (!row) {
            this.phase = 'headers'
            this.after = 0
            continue
          }
          const submission: AgentJournalSubmission = JSON.parse(String(row.payload_json))
          const keys = savedRewindKeys([submission])
          const itemId = agentJournalItemKey({
            provider: 'orca',
            clientMessageId: submission.clientMessageId
          })
          this.db
            .prepare('INSERT OR REPLACE INTO temp.fork_aliases VALUES(?,?)')
            .run(itemId, keys.providerKey(itemId))
          if (keys.omitted.has(itemId)) {
            this.omit(itemId)
          }
          this.after = Number(row.ordinal)
          account(row)
          break
        }
        case 'headers': {
          const row = this.db
            .prepare(`SELECT item_id,sequence,sequence_index,ordinal,turn_item_id,turn_id,provider_turn_id
            FROM journal_items INDEXED BY journal_items_visible_position
            WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>?
              AND (sequence,sequence_index,ordinal)>(?,?,?) ORDER BY sequence,sequence_index,ordinal LIMIT 1`)
            .get(...prefix, this.floor, ...this.position)
          if (!row) {
            this.phase = 'members'
            this.after = 0
            continue
          }
          const providerKey =
            this.db
              .prepare('SELECT provider_key FROM temp.fork_aliases WHERE item_id=?')
              .get(row.item_id)?.provider_key ?? row.item_id
          this.db
            .prepare(`INSERT INTO temp.fork_headers(item_id,provider_key,turn_item_id,turn_id,provider_turn_id,sequence,sequence_index,ordinal)
            VALUES(?,?,?,?,?,?,?,?)`)
            .run(
              row.item_id,
              providerKey,
              row.turn_item_id,
              row.turn_id,
              row.provider_turn_id,
              row.sequence,
              row.sequence_index,
              row.ordinal
            )
          this.position = [Number(row.sequence), Number(row.sequence_index), Number(row.ordinal)]
          account(row)
          break
        }
        case 'members': {
          const row = this.db
            .prepare(
              'SELECT rank,item_id,provider_key,turn_item_id,turn_id,provider_turn_id FROM temp.fork_headers WHERE rank>? ORDER BY rank LIMIT 1'
            )
            .get(this.after)
          if (!row) {
            if (this.nextItemId !== null) {
              const next = this.db
                .prepare('SELECT rank,member FROM temp.fork_headers WHERE item_id=?')
                .get(this.nextItemId)
              if (!next) {
                throw new Error('agent_session_fork:missing-boundary')
              }
              const first =
                next.member === null
                  ? next
                  : this.db
                      .prepare(
                        'SELECT rank FROM temp.fork_headers WHERE member=? ORDER BY rank LIMIT 1'
                      )
                      .get(next.member)!
              this.end = Number(first.rank)
            }
            this.phase = 'kept'
            this.after = 0
            continue
          }
          const identity = parseAgentJournalItemKey(String(row.provider_key))
          let member: string | null = null
          if (this.input.sourceThreadId) {
            const root =
              row.turn_item_id === null
                ? row
                : this.db
                    .prepare(
                      'SELECT provider_turn_id,turn_id FROM temp.fork_headers WHERE item_id=?'
                    )
                    .get(row.turn_item_id)
            member =
              sourceThreadTurnMembership(
                identity,
                this.input.sourceThreadId,
                root?.provider_turn_id != null
                  ? String(root.provider_turn_id)
                  : root?.turn_id != null
                    ? String(root.turn_id)
                    : undefined
              ) ?? null
          } else {
            member =
              row.turn_item_id !== null
                ? String(row.turn_item_id)
                : row.turn_id === null
                  ? null
                  : String(row.item_id)
          }
          this.db
            .prepare('UPDATE temp.fork_headers SET member=? WHERE rank=?')
            .run(member, row.rank)
          this.after = Number(row.rank)
          account(row)
          break
        }
        case 'kept': {
          const row = this.db
            .prepare(
              'SELECT rank,member FROM temp.fork_headers WHERE rank>? AND rank<? ORDER BY rank LIMIT 1'
            )
            .get(this.after, this.end)
          if (!row) {
            this.phase = 'capture'
            this.after = 0
            continue
          }
          if (row.member !== null) {
            this.db.prepare('INSERT OR IGNORE INTO temp.fork_kept VALUES(?)').run(row.member)
          }
          this.after = Number(row.rank)
          account(row)
          break
        }
        case 'capture': {
          if (this.edges) {
            const edge = this.edges.next()
            if (edge.done) {
              this.edges = undefined
            } else {
              this.db
                .prepare('INSERT OR IGNORE INTO temp.fork_edges VALUES(?,?)')
                .run(...edge.value)
              account(JSON.stringify(edge.value))
            }
            continue
          }
          const row = this.db
            .prepare(`SELECT header.rank,header.item_id,header.provider_key,item.wire_version,item.wire_json,item.payload_json
            FROM temp.fork_headers header CROSS JOIN journal_items item
            WHERE header.rank>? AND (header.rank<? OR EXISTS(SELECT 1 FROM temp.fork_kept WHERE member=header.member))
              AND item.session_id=? AND item.epoch=? AND item.item_id=header.item_id
            ORDER BY header.rank LIMIT 1`)
            .get(this.after, this.end, ...prefix)
          if (!row) {
            // No domain writer acknowledgement is needed to release this WAL snapshot.
            this.db.exec('COMMIT')
            this.sourceOpen = false
            this.presentation = new JournalForkPresentation(this.db, this.input)
            this.after = 0
            return { kind: 'progress', sourceReleased: true }
          }
          const { item, payload } = readJournalDomainDisplayedRow(
            this.db,
            { sessionId: prefix[0], epoch: prefix[1] },
            row
          )
          const identity = parseAgentJournalItemKey(String(row.provider_key))
          if (!identity) {
            throw new Error('agent_session_fork:missing-identity')
          }
          const mapped = agentJournalItemKey(
            identity.provider === 'codex' &&
              identity.threadId === this.input.sourceThreadId &&
              this.input.childThreadId
              ? { ...identity, threadId: this.input.childThreadId }
              : identity
          )
          this.db
            .prepare('INSERT INTO temp.fork_bodies(rank,item_id,payload,mapped) VALUES(?,?,?,?)')
            .run(row.rank, item.itemId, payload, mapped)
          this.edges = forkDependencies(item)
          if (omitForkPresentation(item.body)) {
            this.omit(item.itemId)
          }
          this.after = Number(row.rank)
          account(row)
          break
        }
      }
    }
    return { kind: 'progress', sourceReleased: !this.sourceOpen }
  }

  close(): void {
    if (this.sourceOpen && this.db.isTransaction) {
      this.db.exec('ROLLBACK')
    }
    this.sourceOpen = false
    this.edges = undefined
    this.db.exec(`DROP TABLE IF EXISTS temp.fork_headers; DROP TABLE IF EXISTS temp.fork_aliases;
      DROP TABLE IF EXISTS temp.fork_kept; DROP TABLE IF EXISTS temp.fork_bodies; DROP TABLE IF EXISTS temp.fork_edges;
      DROP TABLE IF EXISTS temp.fork_omitted; DROP TABLE IF EXISTS temp.fork_work`)
    this.presentation = undefined
  }

  private omit(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO temp.fork_omitted(id) VALUES(?)').run(id)
  }
}
