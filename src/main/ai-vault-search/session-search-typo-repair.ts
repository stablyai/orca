import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchScope } from './session-search-engine-types'
import { quoteFtsTerm } from './session-search-query-planner'
import { scopedExpression } from './session-search-retrieval'

// Why: a query term with zero postings is usually a typo. The index's own
// vocabulary (fts5vocab) is the dictionary, so repair needs no model and can
// never suggest a word the index does not contain. Measured MRR 0.553 → 0.566.
const MIN_TERM_LENGTH = 4
const MAX_TERM_LENGTH = 40
const LENGTH_SLACK = 2
const MIN_DOC_FREQUENCY = 2
const MIN_SIMILARITY = 0.82
const MAX_CANDIDATES = 4000
// Candidates counted against live rows per prefix before giving up on it. Only
// reached for a term the scope has no posting for, which is the rare case.
const MAX_VISIBILITY_PROBES = 8
// How far a live count walks before it stops caring. It exists to break ties
// between candidates of equal similarity, and the difference between a term in
// sixty-four rows and one in six thousand does not change which is the better
// repair — but reading either in full would.
const MAX_COUNTED_ROWS = 64

// Longest common subsequence length; the indel distance is len(a)+len(b)-2·LCS.
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

/**
 * Spelling repair over the index's own vocabulary.
 *
 * The vocabulary proposes and a scoped count disposes. `messages_vocab` is a
 * view over the whole FTS b-tree: it has no column filter, because fts5vocab is
 * per table, and it counts rows whose session a purge already cut loose. So
 * every decision that reaches the plan — whether a term is already spelled
 * right, whether a candidate is eligible, and which of two equally close
 * candidates wins — is taken from a `messages_fts MATCH` under the same column
 * filter retrieval uses, joined to `sessions`.
 *
 * That is not tidiness. Reading the vocabulary directly made the repair depend
 * on rows the search could never return: tool output suppressed a
 * conversation-scope repair and supplied suggestions the scope would never
 * show, and retention's orphan drain silently changed which word a query was
 * repaired to.
 *
 * The cost is one bounded count per candidate examined, at most
 * `MAX_VISIBILITY_PROBES` per prefix, and only for a term the scope has no
 * posting for. See docs/reference/agent-session-search-query-tuning.md.
 */
export class SessionSearchTypoRepair {
  private readonly liveRows: ReturnType<SyncDatabase['prepare']>
  private readonly candidatesByPrefix: ReturnType<SyncDatabase['prepare']>

  constructor(db: SyncDatabase) {
    this.liveRows = db.prepare(
      `SELECT count(*) AS rows FROM (
         SELECT m.id FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE messages_fts MATCH ? LIMIT ${MAX_COUNTED_ROWS})`
    )
    // fts5vocab is ordered by term, so a prefix range plus a length band is a
    // bounded scan and no sort. Ordered by term rather than by `doc`: the
    // ordering decides which candidates survive the limit, and `doc` counts
    // rows no reader can see, so the drain reclaiming them moved the cut.
    this.candidatesByPrefix = db.prepare(
      `SELECT term FROM messages_vocab
       WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?
       ORDER BY term LIMIT ?`
    )
  }

  /** Live rows carrying this term inside `scope`, counted no further than it matters. */
  private countRows(term: string, scope: SessionSearchScope): number {
    const row = this.liveRows.get(scopedExpression(scope, quoteFtsTerm(term))) as { rows: number }
    return row.rows
  }

  /** Whether a live row inside `scope` holds this term. */
  hasPostings(term: string, scope: SessionSearchScope): boolean {
    return this.countRows(term, scope) > 0
  }

  /** Returns the closest indexed term, or null when `term` exists or nothing is close enough. */
  correct(term: string, scope: SessionSearchScope): string | null {
    const lowered = term.toLowerCase()
    if (lowered.length < MIN_TERM_LENGTH || lowered.length > MAX_TERM_LENGTH) {
      return null
    }
    if (this.hasPostings(lowered, scope)) {
      return null
    }
    // Two-letter prefix first (a typo rarely hits both), then the transposed
    // pair, then the bare first letter as the wide fallback.
    const prefixes = [lowered.slice(0, 2), lowered[1] + lowered[0], lowered[0]]
    for (const prefix of prefixes) {
      const best = this.bestVisible(lowered, prefix, scope)
      if (best) {
        return best
      }
    }
    return null
  }

  /**
   * The closest candidate at `prefix` that this scope can actually answer with.
   *
   * Ranking is pure CPU, so the walk is bounded rather than the count: the
   * closest term can be one the scope never shows, and abandoning the prefix
   * there would lose a repair the rest of the index can serve. Ties on
   * similarity go to the more common word, which is the same prior the
   * vocabulary's `doc` used to supply — counted live here so the answer does
   * not move when a purge reclaims rows nothing could reach.
   */
  private bestVisible(lowered: string, prefix: string, scope: SessionSearchScope): string | null {
    const counted = this.ranked(lowered, prefix)
      .slice(0, MAX_VISIBILITY_PROBES)
      .map((candidate) => ({ ...candidate, rows: this.countRows(candidate.term, scope) }))
      .filter((candidate) => candidate.rows >= MIN_DOC_FREQUENCY)
    if (counted.length === 0) {
      return null
    }
    // Already sorted by similarity; a stable sort keeps that and orders the ties.
    return counted.sort((left, right) => right.score - left.score || right.rows - left.rows)[0]!
      .term
  }

  /** Candidates similar enough to be a repair, closest first. */
  private ranked(lowered: string, prefix: string): { term: string; score: number }[] {
    return this.candidates(prefix, lowered.length)
      .map((row) => ({ term: row.term, score: similarity(lowered, row.term) }))
      .filter((candidate) => candidate.score >= MIN_SIMILARITY)
      .sort((left, right) => right.score - left.score || (left.term < right.term ? -1 : 1))
  }

  private candidates(prefix: string, length: number): { term: string }[] {
    const last = prefix.charCodeAt(prefix.length - 1)
    const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1)
    return this.candidatesByPrefix.all(
      prefix,
      upper,
      Math.max(MIN_TERM_LENGTH - 1, length - LENGTH_SLACK),
      length + LENGTH_SLACK,
      MAX_CANDIDATES
    ) as { term: string }[]
  }
}
