import type SyncDatabase from '../sqlite/sync-database'
import { quoteFtsTerm } from './session-search-query-planner'
import { VISIBLE_MESSAGES, VISIBLE_SESSIONS } from './session-search-schema'

// Why: a query term with zero postings is usually a typo. The index's own
// vocabulary (fts5vocab) is the dictionary, so repair needs no model and can
// never suggest a word the index does not contain. Measured MRR 0.553 → 0.566.
const MIN_TERM_LENGTH = 4
const MAX_TERM_LENGTH = 40
const LENGTH_SLACK = 2
const MIN_DOC_FREQUENCY = 2
const MIN_SIMILARITY = 0.82
const MAX_CANDIDATES = 4000
// Visibility probes walked per prefix before giving up on it. Each one is an
// FTS MATCH and only runs mid-write, so this is the whole cost of the fall-through.
const MAX_VISIBILITY_PROBES = 8

type VocabRow = { term: string; doc: number }

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

export class SessionSearchTypoRepair {
  private readonly unpublished: ReturnType<SyncDatabase['prepare']>
  private readonly visiblePostings: ReturnType<SyncDatabase['prepare']>
  private readonly exactMatch: ReturnType<SyncDatabase['prepare']>
  private readonly documentFrequency: ReturnType<SyncDatabase['prepare']>
  private readonly candidatesByPrefix: ReturnType<SyncDatabase['prepare']>

  constructor(db: SyncDatabase) {
    this.unpublished = db.prepare(
      'SELECT 1 FROM search_write_batches UNION ALL SELECT 1 FROM search_pending_deletes LIMIT 1'
    )
    this.visiblePostings =
      db.prepare(`SELECT m.id FROM messages_fts JOIN ${VISIBLE_MESSAGES} m ON m.id=messages_fts.rowid
      JOIN ${VISIBLE_SESSIONS} s ON s.id=m.session_row_id WHERE messages_fts MATCH ?
      LIMIT ${MIN_DOC_FREQUENCY}`)

    this.exactMatch = db.prepare(
      'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? LIMIT 1'
    )
    this.documentFrequency = db.prepare('SELECT doc FROM messages_vocab WHERE term = ?')
    // fts5vocab is ordered by term, so a prefix range plus a length band is a
    // bounded scan; the most frequent terms are kept when the band overflows.
    this.candidatesByPrefix = db.prepare(
      `SELECT term, doc FROM messages_vocab
       WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ? AND doc >= ?
       ORDER BY doc DESC LIMIT ?`
    )
  }

  hasPostings(term: string): boolean {
    if (this.hasUnpublishedWrites()) {
      return this.visiblePostings.all(quoteFtsTerm(term)).length > 0
    }
    const row = this.documentFrequency.get(term.toLowerCase()) as VocabRow | undefined
    // unicode61 also folds Latin diacritics; raw vocabulary spelling alone can miss an exact hit.
    return (
      (row !== undefined && row.doc > 0) || this.exactMatch.get(quoteFtsTerm(term)) !== undefined
    )
  }

  /** A staged write is uncommitted, so `messages_vocab` can list a term no visible row has yet. */
  private hasUnpublishedWrites(): boolean {
    return this.unpublished.get() !== undefined
  }

  /** Returns the closest indexed term, or null when `term` exists or nothing is close enough. */
  correct(term: string): string | null {
    const lowered = term.toLowerCase()
    if (lowered.length < MIN_TERM_LENGTH || lowered.length > MAX_TERM_LENGTH) {
      return null
    }
    if (this.hasPostings(lowered)) {
      return null
    }
    // Two-letter prefix first (a typo rarely hits both), then the transposed
    // pair, then the bare first letter as the wide fallback.
    const prefixes = [lowered.slice(0, 2), lowered[1] + lowered[0], lowered[0]]
    for (const prefix of prefixes) {
      const best = this.bestVisible(lowered, prefix)
      if (best) {
        return best
      }
    }
    return null
  }

  /**
   * The best-scoring candidate at `prefix` that a reader can actually see.
   * Ranking is pure CPU, so the walk is bounded rather than the probe: mid-write
   * the top term can be staged, and abandoning the prefix there would lose a
   * repair the published index can serve.
   */
  private bestVisible(lowered: string, prefix: string): string | null {
    const ranked = this.ranked(lowered, prefix).slice(0, MAX_VISIBILITY_PROBES)
    return ranked.find((candidate) => this.isVisible(candidate.term))?.term ?? null
  }

  /** Candidates similar enough to be a repair, best first. */
  private ranked(lowered: string, prefix: string): { term: string; score: number; doc: number }[] {
    return this.candidates(prefix, lowered.length)
      .map((row) => ({ term: row.term, score: similarity(lowered, row.term), doc: row.doc }))
      .filter((candidate) => candidate.score >= MIN_SIMILARITY)
      .sort((left, right) => right.score - left.score || right.doc - left.doc)
  }

  private isVisible(term: string): boolean {
    return (
      !this.hasUnpublishedWrites() ||
      this.visiblePostings.all(quoteFtsTerm(term)).length >= MIN_DOC_FREQUENCY
    )
  }

  private candidates(prefix: string, length: number): VocabRow[] {
    const last = prefix.charCodeAt(prefix.length - 1)
    const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1)
    return this.candidatesByPrefix.all(
      prefix,
      upper,
      Math.max(MIN_TERM_LENGTH - 1, length - LENGTH_SLACK),
      length + LENGTH_SLACK,
      MIN_DOC_FREQUENCY,
      MAX_CANDIDATES
    ) as VocabRow[]
  }
}
