import { performance } from 'node:perf_hooks'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { JournalTransaction } from './journal-database'
import { JournalPrunePolicy } from './journal-prune-policy'
import { JournalPruneRefusal, JournalPruneState } from './journal-prune-state'
import { parseJournalRow } from './journal-row-schema'
import { readJournalRowsAfter, readJournalSessionEpoch } from './journal-row-table'

export const JOURNAL_PRUNE_MAX_ROWS = 32
const MAX_PASS_BYTES = 256 * 1024
const PASS_BUDGET_MS = 4
const CHECKPOINT_ROWS = 4096

function journalPruneUpper(db: Database.Database, sessionId: string, epoch: string): number {
  const seq = db
    .prepare(`SELECT MAX(seq) AS seq FROM journal_rows
WHERE session_id = ? AND epoch = ?`)
    .get(sessionId, epoch)?.seq
  return typeof seq === 'number' ? seq : 0
}

/** An unfinished pass retains its transient frontier until its completed horizon is saved. */
export class JournalPrunePass {
  private readonly state: JournalPruneState
  private readonly policy: JournalPrunePolicy
  private readonly initialUpper: number
  private initialized = false
  private scanned = 0

  constructor(
    db: Database.Database,
    readonly sessionId: string,
    readonly epoch: string
  ) {
    this.state = new JournalPruneState(db, sessionId, epoch)
    this.policy = new JournalPrunePolicy(this.state)
    this.initialUpper = journalPruneUpper(db, sessionId, epoch)
  }

  refuse(transaction: JournalTransaction): void {
    transaction(() => this.state.refuse(), 'DEFERRED')
  }

  step(
    db: Database.Database,
    transaction: JournalTransaction
  ): {
    done: boolean
    compacted: number
    scanned: number
  } {
    // A replaced epoch's bookkeeping is collected as garbage.
    if (readJournalSessionEpoch(db, this.sessionId) !== this.epoch) {
      return { done: true, compacted: 0, scanned: 0 }
    }
    if (!this.initialized) {
      transaction(() => this.state.initialize(), 'DEFERRED')
      this.scanned = this.state.progress().scanned
      this.initialized = true
    }
    const progress = this.state.progress()
    if (progress.refused) {
      return { done: true, compacted: 0, scanned: 0 }
    }
    const upper = this.initialUpper
    if (upper < this.scanned) {
      throw new JournalPruneRefusal('journal pruning refused a shortened epoch')
    }
    if (this.scanned < upper) {
      const through = transaction(
        () => this.scanSuffix(db, this.scanned, upper, progress.scanned),
        'DEFERRED'
      )
      // Publish only after COMMIT and the host's foreground durability restoration succeed.
      const scanned = through - this.scanned
      this.scanned = through
      return { done: false, compacted: 0, scanned }
    }
    const obsolete = this.state.next()
    if (obsolete === null) {
      return { done: true, compacted: 0, scanned: 0 }
    }
    const compacted = shrinkSupersededPayload(db, this.state, obsolete, transaction)
    return { done: false, compacted: Number(compacted), scanned: 0 }
  }

  private scanSuffix(db: Database.Database, after: number, upper: number, saved: number): number {
    const started = performance.now()
    let scanned = 0
    let bytes = 0
    const obsolete: number[] = []
    while (after < upper && scanned < JOURNAL_PRUNE_MAX_ROWS && bytes < MAX_PASS_BYTES) {
      const stored = readJournalRowsAfter(db, this.sessionId, this.epoch, after, 1)[0]
      if (!stored || stored.seq !== after + 1 || stored.seq > upper) {
        throw new JournalPruneRefusal('journal pruning refused a sequence gap')
      }
      const parsed = parseJournalRow(stored.rowJson)
      if (!parsed.ok || parsed.row.seq !== stored.seq || parsed.row.epoch !== this.epoch) {
        throw new JournalPruneRefusal('journal pruning refused an unreadable row')
      }
      if (after === 0 && parsed.row.kind !== 'epoch') {
        throw new JournalPruneRefusal('journal pruning refused a missing epoch row')
      }
      const sequence = this.policy.observe(parsed.row, stored.ts)
      if (sequence !== null) {
        obsolete.push(sequence)
      }
      after = stored.seq
      scanned++
      bytes += Buffer.byteLength(stored.rowJson, 'utf8')
      if (performance.now() - started >= PASS_BUDGET_MS) {
        break
      }
    }
    if (after === upper || after - saved >= CHECKPOINT_ROWS || obsolete.length > 0) {
      for (const sequence of obsolete) {
        this.state.enqueue(sequence)
      }
      this.state.advance(after)
    }
    return after
  }
}

function shrinkSupersededPayload(
  db: Database.Database,
  state: JournalPruneState,
  sequence: number,
  transaction: JournalTransaction
): boolean {
  const { sessionId, epoch } = state
  const stored = readJournalRowsAfter(db, sessionId, epoch, sequence - 1, 1)[0]
  const parsed = stored && parseJournalRow(stored.rowJson)
  if (
    !parsed?.ok ||
    parsed.row.kind !== 'item' ||
    stored.seq !== sequence ||
    parsed.row.seq !== sequence ||
    parsed.row.epoch !== epoch
  ) {
    throw new JournalPruneRefusal('journal pruning could not retain its superseded row')
  }
  const bodyJson = JSON.stringify(compactJournalPayload(parsed.row.body))
  if (Buffer.byteLength(bodyJson) >= Buffer.byteLength(JSON.stringify(parsed.row.body))) {
    transaction(() => state.consume(sequence), 'DEFERRED')
    return false
  }
  // Atomic same-key replacement reclaims leaf pages as well as overflow pages.
  return transaction((db) => {
    const removed = db
      .prepare(`DELETE FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq = ? AND row_json = ?`)
      .run(sessionId, epoch, sequence, stored.rowJson)
    if (removed.changes === 0) {
      throw new JournalPruneRefusal('journal pruning refused a changed superseded row')
    }
    db.prepare(`INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json)
VALUES (?, ?, ?, ?, json_set(?, '$.body', json(?)))`).run(
      sessionId,
      epoch,
      sequence,
      stored.ts,
      stored.rowJson,
      bodyJson
    )
    state.consume(sequence)
    return true
  })
}

function compactJournalPayload(body: AgentJournalItemBody): AgentJournalItemBody {
  if (body.kind === 'message') {
    return { ...body, blocks: [] }
  }
  if (body.kind === 'tool-call') {
    return {
      ...body,
      input: null,
      output: undefined,
      webSearchResults: undefined
    }
  }
  if (body.kind === 'diff') {
    return { ...body, patch: { ...body.patch, head: '' } }
  }
  if (body.kind === 'turn') {
    return { ...body, contextUsage: undefined }
  }
  if (body.kind === 'status' && body.turnLifecycle) {
    return {
      ...body,
      turnLifecycle: { ...body.turnLifecycle, contextUsage: undefined }
    }
  }
  return body
}
