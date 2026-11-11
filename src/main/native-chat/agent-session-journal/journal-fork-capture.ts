import type Database from '../../sqlite/sync-database'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  forkDependencies,
  omitForkPresentation
} from '../agent-session-wire/acquisition/structured-agent-session-fork-snapshot'
import {
  readJournalDomainDisplayedRow,
  readJournalDomainStopStates,
  type JournalDomainItemTarget
} from './journal-domain-item-display'
import type { JournalForkPreparationInput } from './journal-fork-preparation'
import { journalForkRowBytes } from './journal-fork-workspace'

/** One dependency item and scalar admission metadata survive a bounded capture step. */
export class JournalForkCapture {
  private after = 0
  private edges?: Generator<readonly [string, string]>

  constructor(
    private readonly db: Database.Database,
    private readonly target: JournalDomainItemTarget,
    private readonly input: JournalForkPreparationInput,
    private readonly end: number
  ) {}

  next(budget: () => boolean, remaining: () => number, account: (bytes: number) => void): boolean {
    const drainEdges = () => {
      while (this.edges && budget()) {
        const edge = this.edges.next()
        if (edge.done) {
          this.edges = undefined
        } else {
          this.db.prepare('INSERT OR IGNORE INTO temp.fork_edges VALUES(?,?)').run(...edge.value)
          account(journalForkRowBytes(edge.value[0]) + journalForkRowBytes(edge.value[1]))
        }
      }
    }
    drainEdges()
    if (!budget()) {
      return false
    }
    const prefix = [this.target.sessionId, this.target.epoch] as const
    const selection = `FROM temp.fork_headers header
      WHERE header.rank>? AND (header.rank<? OR EXISTS(SELECT 1 FROM temp.fork_kept WHERE member=header.member))
      ORDER BY header.rank LIMIT ?`
    const ids = this.db
      .prepare(`SELECT header.item_id ${selection}`)
      .all(this.after, this.end, remaining())
      .map((row) => String(row.item_id))
    const states = readJournalDomainStopStates(this.db, this.target, ids)
    let exhausted = true
    for (const row of this.db
      .prepare(`SELECT header.rank,header.item_id,header.provider_key,
      item.wire_version,item.wire_json,item.payload_json
      FROM temp.fork_headers header LEFT JOIN journal_items item
        ON item.session_id=?3 AND item.epoch=?4 AND item.item_id=header.item_id
      WHERE header.rank>?1 AND (header.rank<?2 OR EXISTS(SELECT 1 FROM temp.fork_kept WHERE member=header.member))
      ORDER BY header.rank LIMIT ?5`)
      .iterate(this.after, this.end, ...prefix, remaining())) {
      if (typeof row.payload_json !== 'string') {
        throw new Error('agent_session_fork:missing-source')
      }
      const { item, payload } = readJournalDomainDisplayedRow(this.db, this.target, row, states)
      const identity = parseAgentJournalItemKey(String(row.provider_key))
      if (!identity || item.itemId !== row.item_id) {
        throw new Error('agent_session_fork:missing-identity')
      }
      const mapped = agentJournalItemKey(
        identity.provider === 'codex' &&
          identity.threadId === this.input.sourceThreadId &&
          this.input.childThreadId
          ? { ...identity, threadId: this.input.childThreadId }
          : identity
      )
      const bodyBytes = Buffer.byteLength(JSON.stringify(item.body))
      const lifecycle = Number(readAgentJournalTurn(item.body) !== null)
      const turnScope = item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null
      this.db
        .prepare(
          `INSERT INTO temp.fork_bodies(rank,item_id,payload,mapped,body_bytes,lifecycle,turn_scope_id) VALUES(?,?,?,?,?,?,?)`
        )
        .run(row.rank, item.itemId, payload, mapped, bodyBytes, lifecycle, turnScope)
      this.edges = forkDependencies(item)
      if (omitForkPresentation(item.body)) {
        this.db.prepare('INSERT OR IGNORE INTO temp.fork_omitted(id) VALUES(?)').run(item.itemId)
      }
      this.after = Number(row.rank)
      account(journalForkRowBytes(row))
      drainEdges()
      if (!budget()) {
        exhausted = false
        break
      }
    }
    return exhausted
  }
}
