import type SyncDatabase from '../sqlite/sync-database'

// Why: a query term with zero postings is usually a typo. The index's own
// vocabulary (fts5vocab) is the dictionary, so repair needs no model and can
// never suggest a word the index does not contain. Measured MRR 0.553 → 0.566.
const MIN_TERM_LENGTH = 4
const MAX_TERM_LENGTH = 40
const LENGTH_SLACK = 2
const MIN_DOC_FREQUENCY = 2
const MIN_SIMILARITY = 0.82
const MAX_CANDIDATES = 4000

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
  private readonly documentFrequency: ReturnType<SyncDatabase['prepare']>
  private readonly candidatesByPrefix: ReturnType<SyncDatabase['prepare']>

  constructor(db: SyncDatabase) {
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
    const row = this.documentFrequency.get(term.toLowerCase()) as VocabRow | undefined
    return row !== undefined && row.doc > 0
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
    let best: { term: string; score: number; doc: number } | null = null
    for (const prefix of prefixes) {
      for (const row of this.candidates(prefix, lowered.length)) {
        const score = similarity(lowered, row.term)
        if (score < MIN_SIMILARITY) {
          continue
        }
        if (!best || score > best.score || (score === best.score && row.doc > best.doc)) {
          best = { term: row.term, score, doc: row.doc }
        }
      }
      if (best) {
        return best.term
      }
    }
    return null
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
