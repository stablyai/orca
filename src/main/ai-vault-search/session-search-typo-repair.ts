import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchScope } from './session-search-engine-types'
import { orExpression, planSessionSearchQuery, quoteFtsTerm } from './session-search-query-planner'
import { SessionSearchPostings } from './session-search-postings'

const MIN_TERM_LENGTH = 4
const MAX_TERM_LENGTH = 40
const LENGTH_SLACK = 2
const MIN_DOC_FREQUENCY = 2
const MIN_SIMILARITY = 0.82
const MAX_VOCABULARY_SEEKS = 4000
const MAX_VISIBILITY_PROBES = 8
// Cap frequency tie-break counts so common terms cannot make repair unbounded.
const MAX_COUNTED_ROWS = 64

export class SessionSearchVocabularyBudget {
  private remaining = MAX_VOCABULARY_SEEKS

  get exhausted(): boolean {
    return this.remaining === 0
  }

  take(): boolean {
    if (this.exhausted) {
      return false
    }
    this.remaining--
    return true
  }
}

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
  private readonly candidatesByPrefix: ReturnType<SyncDatabase['prepare']>

  constructor(private readonly db: SyncDatabase) {
    // Why: row vocabulary computes full doclist counts before returning even one term.
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS temp.session_search_vocab USING fts5vocab(main,messages_fts,'instance')"
    )
    this.candidatesByPrefix = db.prepare(
      `SELECT term FROM temp.session_search_vocab WHERE term >= ? ORDER BY term LIMIT 1`
    )
  }

  private countRows(expression: string, postings: SessionSearchPostings): number {
    let rows = 0
    for (const _row of postings.matching(expression)) {
      if (++rows >= MAX_COUNTED_ROWS) {
        break
      }
    }
    return rows
  }

  correct(
    term: string,
    scope: SessionSearchScope,
    postings = new SessionSearchPostings(this.db, scope),
    vocabulary = new SessionSearchVocabularyBudget()
  ): string | null {
    const lowered = term.toLowerCase()
    if (lowered.length < MIN_TERM_LENGTH || lowered.length > MAX_TERM_LENGTH) {
      return null
    }
    const ownExpression = orExpression(
      planSessionSearchQuery(term).terms.filter((spelling) => spelling.toLowerCase() === lowered)
    )
    if (this.countRows(ownExpression, postings) > 0 || postings.exhausted) {
      return null
    }
    // Widen cautiously: common prefix, transposed pair, then first letter.
    const prefixes = [lowered.slice(0, 2), lowered[1] + lowered[0], lowered[0]]
    for (const prefix of prefixes) {
      const best = this.bestVisible(lowered, prefix, postings, vocabulary)
      if (best) {
        return best
      }
    }
    return null
  }

  /** Probe several ranked candidates so an invisible best match does not suppress a live repair. */
  private bestVisible(
    lowered: string,
    prefix: string,
    postings: SessionSearchPostings,
    vocabulary: SessionSearchVocabularyBudget
  ): string | null {
    const counted = this.ranked(lowered, prefix, vocabulary)
      .slice(0, MAX_VISIBILITY_PROBES)
      .map((candidate) => ({
        ...candidate,
        rows: this.countRows(quoteFtsTerm(candidate.term), postings)
      }))
      .filter((candidate) => candidate.rows >= MIN_DOC_FREQUENCY)
    if (counted.length === 0) {
      return null
    }
    // Stable ties preserve the lexical ordering from ranked().
    return counted.sort((left, right) => right.score - left.score || right.rows - left.rows)[0]!
      .term
  }

  private ranked(
    lowered: string,
    prefix: string,
    vocabulary: SessionSearchVocabularyBudget
  ): { term: string; score: number }[] {
    return this.candidates(prefix, lowered.length, vocabulary)
      .map((row) => ({ term: row.term, score: similarity(lowered, row.term) }))
      .filter((candidate) => candidate.score >= MIN_SIMILARITY)
      .sort((left, right) => right.score - left.score || (left.term < right.term ? -1 : 1))
  }

  private candidates(
    prefix: string,
    length: number,
    vocabulary: SessionSearchVocabularyBudget
  ): { term: string }[] {
    const terms: { term: string }[] = []
    let next = prefix
    while (vocabulary.take()) {
      const term = this.candidatesByPrefix.get(next)?.term
      if (typeof term !== 'string' || !term.startsWith(prefix)) {
        break
      }
      // Why: strict > filters occurrences; the TEXT successor seeks past the whole doclist.
      next = `${term}\u0000`
      const termLength = Array.from(term).length
      if (
        termLength >= Math.max(MIN_TERM_LENGTH - 1, length - LENGTH_SLACK) &&
        termLength <= length + LENGTH_SLACK
      ) {
        terms.push({ term })
      }
    }
    return terms
  }
}
