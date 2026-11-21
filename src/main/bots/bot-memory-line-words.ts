// How Orca compares a memory line's words: whether a rewrite says only what its sources said, and how
// alike two lines are, so a model's merge can't add a claim and a moved line can't come back renamed.

const STOPWORDS = new Set(
  'a an the and or but of to in on at for by with from as is are was were be been being it its this that these those then than so if into over under via per their they them our we you your i he she his her has have had also just there here which who what when where how all any each every one'.split(
    ' '
  )
)

/** Negations and modals flip a line's meaning, so a rewrite may use one only when a source does. */
const MEANING_WORDS = new Set([
  'not',
  'no',
  'never',
  'always',
  'must',
  'only',
  "don't",
  'dont',
  "can't",
  'cant',
  'cannot',
  'should',
  'instead',
  "won't",
  'without',
  'will',
  'would',
  'can',
  'could',
  'may',
  'might',
  "shouldn't",
  "doesn't",
  "isn't"
])

/** One way to write each negation, so "don't" and "do not" read alike. */
const SAME_MEANING: Record<string, string> = {
  "don't": 'not',
  dont: 'not',
  "doesn't": 'not',
  "isn't": 'not',
  "can't": 'cannot',
  cant: 'cannot',
  "won't": 'will not',
  "shouldn't": 'should not'
}

/** Each negation or modal in `text` with the next two words it governs, e.g. "not deploy staging":
 *  "Do not deploy staging; deploy production" never matches "deploy staging; do not deploy
 *  production". */
function meaningMarks(text: string): string[] {
  const words = lineWords(text)
  return words.flatMap((word, index) => {
    if (!MEANING_WORDS.has(word)) {
      return []
    }
    const governed = words
      .slice(index + 1)
      .filter((next) => !STOPWORDS.has(next) && !MEANING_WORDS.has(next) && next !== 'do')
      .slice(0, 2)
      .map(stem)
    return [[SAME_MEANING[word] ?? word, ...governed].join(' ')]
  })
}

const MAX_NEW_WORDS = 3
const MAX_NEW_SHARE = 0.15

export function lineWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[’]/g, "'")
      .match(/[a-z0-9][a-z0-9'_-]*/g) ?? []
  )
}

/** A word's plain stem, so "merged" and "merges" read as "merge". */
function stem(word: string): string {
  return word.replace(/(?:'s|ing|ed|es|s)$/, '') || word
}

const SPECIAL = /https?:\/\/\S+|`[^`]+`|@[\w-]+|[\w.-]*\/[\w./-]+|\d[\d.,:]*/g

/** Capitalized words past a sentence's start: names. */
function names(text: string): string[] {
  return [...text.matchAll(/(?<![.!?:]\s|^)(?<=\s|\()([A-Z][\w-]+)/g)].map((m) =>
    m[1].toLowerCase()
  )
}

/**
 * Whether `text` says only what `sources` say: every number, link, path, @name, code span and name
 * in it is in them, every negation or modal is too, and at most a few other words are new. Every
 * negation or modal of `keep` (the words the text restates) stays, so "Do not deploy" can't become
 * "deploy" nor "may" become "will".
 */
export function isDerivable(
  text: string,
  sources: readonly string[],
  keep: readonly string[] = sources
): boolean {
  const source = sources.join('\n')
  const lower = source.toLowerCase()
  if ((text.match(SPECIAL) ?? []).some((piece) => !lower.includes(piece.toLowerCase()))) {
    return false
  }
  const known = new Set(lineWords(source))
  const stems = new Set([...known].map(stem))
  if (names(text).some((name) => !known.has(name))) {
    return false
  }
  const words = lineWords(text)
  // Each negation or modal with the words it governs: none new, none of `keep`'s dropped or moved.
  const marks = meaningMarks(text)
  const sourceMarks = new Set(sources.flatMap(meaningMarks))
  if (marks.some((mark) => !sourceMarks.has(mark))) {
    return false
  }
  const said = new Set(marks)
  if (keep.some((line) => meaningMarks(line).some((mark) => !said.has(mark)))) {
    return false
  }
  const fresh = words.filter(
    (word) => !STOPWORDS.has(word) && !known.has(word) && !stems.has(stem(word))
  )
  return fresh.length <= Math.min(MAX_NEW_WORDS, Math.floor(words.length * MAX_NEW_SHARE))
}

export const keyWords = (text: string): Set<string> =>
  new Set(
    lineWords(text)
      .filter((word) => !STOPWORDS.has(word))
      .map(stem)
  )

/** Jaccard similarity of two lines' key words. */
export function lineSimilarity(a: string, b: string): number {
  return wordSimilarity(keyWords(a), keyWords(b))
}

/** Jaccard similarity of two key-word sets, for callers that compare one line with many. */
export function wordSimilarity(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (x.size === 0 || y.size === 0) {
    return 0
  }
  const shared = [...x].filter((word) => y.has(word)).length
  return shared / (x.size + y.size - shared)
}

/** How much of `line`'s key words `words` holds: 1 when every one is there. */
export function lineCoverage(line: string, words: string): number {
  const wanted = keyWords(line)
  if (wanted.size === 0) {
    return 0
  }
  const have = keyWords(words)
  return [...wanted].filter((word) => have.has(word)).length / wanted.size
}
