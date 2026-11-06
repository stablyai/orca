import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchScope } from './session-search-engine-types'
import { quoteFtsTerm, scopedExpression } from './session-search-query-planner'

const MIN_TERM_LENGTH = 4
const MAX_TERM_LENGTH = 40
const LENGTH_SLACK = 2
const MIN_DOC_FREQUENCY = 2
const MIN_SIMILARITY = 0.82
const MAX_CANDIDATES = 4000
const MAX_VISIBILITY_PROBES = 8
const MAX_EXAMINED_POSTINGS = 1024
// Cap frequency tie-break counts so common terms cannot make repair unbounded.
const MAX_COUNTED_ROWS = 64

function commonSubsequenceLength(a: string, b: string): number {
  let previous = Array.from<number>({ length: b.length + 1 }).fill(0)
  let current = Array.from<number>({ length: b.length + 1 }).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1])
    }
    ;[previous, current] = [current, previous]
  }
  return previous[b.length]
}

/** Normalized indel similarity in [0, 1], the scale rapidfuzz's `fuzz.ratio` uses. */
function similarity(a: string, b: string): number {
  const total = a.length + b.length
  return total === 0 ? 1 : (2 * commonSubsequenceLength(a, b)) / total
}

/** Validate against live scoped rows: vocabulary includes other columns and orphans. */
export class SessionSearchTypoRepair {
  private readonly liveRows: ReturnType<SyncDatabase['prepare']>
  private readonly candidatesByPrefix: ReturnType<SyncDatabase['prepare']>

  constructor(db: SyncDatabase) {
    this.liveRows = db.prepare(
      // Why: admit unscoped postings before filtering so tools and orphans consume the same budget.
      `WITH postings AS MATERIALIZED (
         SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
         LIMIT ${MAX_EXAMINED_POSTINGS + 1}
       ), visible AS (
         SELECT m.id FROM (SELECT rowid FROM postings LIMIT ${MAX_EXAMINED_POSTINGS}) admitted
         JOIN messages m ON m.id = admitted.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE m.role != 'tool' AND (? = 'all' OR EXISTS (
           SELECT 1 FROM messages_fts WHERE rowid = admitted.rowid AND messages_fts MATCH ?
         )) LIMIT ${MAX_COUNTED_ROWS}
       ) SELECT count(*) AS rows, (SELECT count(*) FROM postings) AS examined FROM visible`
    )
    // Term order uses the vocab index and keeps the candidate cutoff independent of orphan counts.
    this.candidatesByPrefix = db.prepare(
      `SELECT term FROM messages_vocab
       WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?
       ORDER BY term LIMIT ?`
    )
  }

  private probeVisibility(
    term: string,
    scope: SessionSearchScope
  ): { rows: number; exhausted: boolean } {
    const quoted = quoteFtsTerm(term)
    const row = this.liveRows.get(quoted, scope, scopedExpression(scope, quoted))
    return {
      rows: Number(row?.rows ?? 0),
      exhausted: Number(row?.examined) > MAX_EXAMINED_POSTINGS
    }
  }

  hasPostings(term: string, scope: SessionSearchScope): boolean {
    const { rows, exhausted } = this.probeVisibility(term, scope)
    return rows > 0 || exhausted
  }

  correct(term: string, scope: SessionSearchScope): string | null {
    const lowered = term.toLowerCase()
    if (lowered.length < MIN_TERM_LENGTH || lowered.length > MAX_TERM_LENGTH) {
      return null
    }
    if (this.hasPostings(lowered, scope)) {
      return null
    }
    // Widen cautiously: common prefix, transposed pair, then first letter.
    const prefixes = [lowered.slice(0, 2), lowered[1] + lowered[0], lowered[0]]
    for (const prefix of prefixes) {
      const best = this.bestVisible(lowered, prefix, scope)
      if (best) {
        return best
      }
    }
    return null
  }

  /** Probe several ranked candidates so an invisible best match does not suppress a live repair. */
  private bestVisible(lowered: string, prefix: string, scope: SessionSearchScope): string | null {
    const counted = this.ranked(lowered, prefix)
      .slice(0, MAX_VISIBILITY_PROBES)
      .map((candidate) => ({
        ...candidate,
        rows: this.probeVisibility(candidate.term, scope).rows
      }))
      .filter((candidate) => candidate.rows >= MIN_DOC_FREQUENCY)
    if (counted.length === 0) {
      return null
    }
    // Stable ties preserve the lexical ordering from ranked().
    return counted.sort((left, right) => right.score - left.score || right.rows - left.rows)[0]!
      .term
  }

  private ranked(lowered: string, prefix: string): { term: string; score: number }[] {
    return this.candidates(prefix, lowered.length)
      .map((row) => ({ term: row.term, score: similarity(lowered, row.term) }))
      .filter((candidate) => candidate.score >= MIN_SIMILARITY)
      .sort((left, right) => right.score - left.score || (left.term < right.term ? -1 : 1))
  }

  private candidates(prefix: string, length: number): { term: string }[] {
    const last = prefix.charCodeAt(prefix.length - 1)
    const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1)
    const rows = this.candidatesByPrefix.all(
      prefix,
      upper,
      Math.max(MIN_TERM_LENGTH - 1, length - LENGTH_SLACK),
      length + LENGTH_SLACK,
      MAX_CANDIDATES
    )
    return rows.flatMap((row) => (typeof row.term === 'string' ? [{ term: row.term }] : []))
  }
}
