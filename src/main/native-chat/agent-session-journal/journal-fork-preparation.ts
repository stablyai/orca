import { JournalForkCapture } from './journal-fork-capture'
import {
  createJournalForkWorkspace,
  journalForkHeaderMember,
  journalForkRowBytes
} from './journal-fork-workspace'
import { JournalForkPresentation } from './journal-fork-presentation'
import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { savedRewindKeys } from '../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
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
  private phase: 'submissions' | 'headers' | 'members' | 'kept' | 'capture' | 'closed' =
    'submissions'
  private presentation?: JournalForkPresentation
  private sourceOpen = false
  private epoch = ''
  private floor = 0
  private nextItemId: string | null = null
  private position = [0, 0, 0]
  private after = -1
  private end = Number.MAX_SAFE_INTEGER
  private captureState?: JournalForkCapture

  constructor(
    private readonly db: Database.Database,
    private readonly input: JournalForkPreparationInput
  ) {
    if (db.isTransaction) {
      throw new Error('fork preparation requires an exclusively reserved reader')
    }
    try {
      createJournalForkWorkspace(db)
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
      this.abort()
      throw error
    }
  }

  get sourceReleased(): boolean {
    return !this.sourceOpen
  }

  next(): JournalForkPreparationResult {
    if (this.phase === 'closed') {
      throw new Error('fork preparation is closed')
    }
    try {
      if (this.presentation) {
        if (this.sourceOpen || this.db.isTransaction) {
          throw new Error('fork presentation requires a released source snapshot')
        }
        this.db.exec('SAVEPOINT fork_presentation')
        const result = this.presentation.next()
        this.db.exec('RELEASE fork_presentation')
        return result
      }
      return this.capture()
    } catch (error) {
      this.abort()
      throw error
    }
  }

  private capture(): JournalForkPreparationResult {
    const start = performance.now()
    let units = 0
    let bytes = 0
    const budget = () =>
      units < MAX_ROWS && bytes < MAX_BYTES && (units === 0 || performance.now() - start < 8)
    const accountBytes = (size: number) => {
      units++
      bytes += size
    }
    const account = (row: SqliteRow | string) => accountBytes(journalForkRowBytes(row))
    const prefix = [this.input.source.sessionId, this.epoch] as const
    while (budget()) {
      switch (this.phase) {
        case 'submissions': {
          let exhausted = true
          for (const row of this.db
            .prepare(`SELECT ordinal,payload_json FROM journal_submission_attempts
            WHERE session_id=? AND epoch=? AND current=1 AND ordinal>? AND (?=0 OR accepted_sequence>?) ORDER BY ordinal LIMIT ?`)
            .iterate(...prefix, this.after, this.floor, this.floor, MAX_ROWS - units)) {
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
            if (!budget()) {
              exhausted = false
              break
            }
          }
          if (exhausted) {
            this.phase = 'headers'
            this.after = 0
          }
          break
        }
        case 'headers': {
          const headers: unknown[][] = []
          let exhausted = true
          for (const row of this.db
            .prepare(`SELECT item_id,sequence,sequence_index,ordinal,turn_item_id,turn_id,provider_turn_id,
              COALESCE((SELECT provider_key FROM temp.fork_aliases alias WHERE alias.item_id=item.item_id),item_id) AS provider_key
            FROM journal_items item INDEXED BY journal_items_visible_position
            WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>?
              AND (sequence,sequence_index,ordinal)>(?,?,?) ORDER BY sequence,sequence_index,ordinal LIMIT ?`)
            .iterate(...prefix, this.floor, ...this.position, MAX_ROWS - units)) {
            headers.push([
              ++this.after,
              row.item_id,
              row.provider_key,
              row.turn_item_id,
              row.turn_id,
              row.provider_turn_id,
              row.sequence,
              row.sequence_index,
              row.ordinal
            ])
            this.position = [Number(row.sequence), Number(row.sequence_index), Number(row.ordinal)]
            const { provider_key: _providerKey, ...header } = row
            account(header)
            if (!budget()) {
              exhausted = false
              break
            }
          }
          if (headers.length) {
            this.db
              .prepare(`INSERT INTO temp.fork_headers(rank,item_id,provider_key,turn_item_id,turn_id,provider_turn_id,sequence,sequence_index,ordinal)
              SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),
                json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),
                json_extract(value,'$[6]'),json_extract(value,'$[7]'),json_extract(value,'$[8]') FROM json_each(?)`)
              .run(JSON.stringify(headers))
          }
          if (exhausted) {
            this.phase = 'members'
            this.after = 0
          }
          break
        }
        case 'members': {
          const members: [number, string | null][] = []
          let exhausted = true
          for (const row of this.db
            .prepare(`SELECT header.rank,header.item_id,header.provider_key,header.turn_item_id,header.turn_id,header.provider_turn_id,
              root.provider_turn_id AS root_provider_turn_id,root.turn_id AS root_turn_id
            FROM temp.fork_headers header LEFT JOIN temp.fork_headers root ON root.item_id=header.turn_item_id
            WHERE header.rank>? ORDER BY header.rank LIMIT ?`)
            .iterate(this.after, MAX_ROWS - units)) {
            const member = journalForkHeaderMember(row, this.input.sourceThreadId)
            members.push([Number(row.rank), member])
            this.after = Number(row.rank)
            const { root_provider_turn_id: _providerTurn, root_turn_id: _turn, ...header } = row
            account(header)
            if (!budget()) {
              exhausted = false
              break
            }
          }
          if (members.length) {
            this.db
              .prepare(`UPDATE temp.fork_headers AS header SET member=json_extract(wanted.value,'$[1]')
              FROM json_each(?) wanted WHERE header.rank=json_extract(wanted.value,'$[0]')`)
              .run(JSON.stringify(members))
          }
          if (exhausted) {
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
          }
          break
        }
        case 'kept': {
          let exhausted = true
          for (const row of this.db
            .prepare(
              'SELECT rank,member FROM temp.fork_headers WHERE rank>? AND rank<? ORDER BY rank LIMIT ?'
            )
            .iterate(this.after, this.end, MAX_ROWS - units)) {
            if (row.member !== null) {
              this.db.prepare('INSERT OR IGNORE INTO temp.fork_kept VALUES(?)').run(row.member)
            }
            this.after = Number(row.rank)
            account(row)
            if (!budget()) {
              exhausted = false
              break
            }
          }
          if (exhausted) {
            this.phase = 'capture'
            this.after = 0
          }
          break
        }
        case 'capture': {
          this.captureState ??= new JournalForkCapture(
            this.db,
            { sessionId: prefix[0], epoch: prefix[1] },
            this.input,
            this.end
          )
          if (this.captureState.next(budget, () => MAX_ROWS - units, accountBytes)) {
            // No domain writer acknowledgement is needed to release this WAL snapshot.
            this.db.exec('COMMIT')
            this.sourceOpen = false
            this.captureState = undefined
            this.presentation = new JournalForkPresentation(this.db, this.input)
            this.after = 0
            return { kind: 'progress', sourceReleased: true }
          }
          break
        }
        case 'closed':
          throw new Error('fork preparation is closed')
      }
    }
    return { kind: 'progress', sourceReleased: !this.sourceOpen }
  }

  close(): void {
    try {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }
      this.db.exec(`DROP TABLE IF EXISTS temp.fork_headers; DROP TABLE IF EXISTS temp.fork_aliases;
        DROP TABLE IF EXISTS temp.fork_kept; DROP TABLE IF EXISTS temp.fork_bodies; DROP TABLE IF EXISTS temp.fork_edges;
        DROP TABLE IF EXISTS temp.fork_omitted; DROP TABLE IF EXISTS temp.fork_work`)
    } catch (error) {
      try {
        this.db.close()
      } catch {}
      throw error
    } finally {
      this.sourceOpen = false
      this.captureState = undefined
      this.presentation = undefined
      this.phase = 'closed'
    }
  }

  private abort(): void {
    try {
      this.close()
    } catch {}
  }

  private omit(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO temp.fork_omitted(id) VALUES(?)').run(id)
  }
}
