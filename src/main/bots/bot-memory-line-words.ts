// How Orca compares a memory line's words: whether a rewrite only shortens a line, and how alike two
// lines are, so a model's merge can't add a claim and a moved line can't come back renamed.

const STOPWORDS = new Set(
  'a an the and or but of to in on at for by with from as is are was were be been being it its this that these those then than so if into over under via per their they them our we you your i he she his her has have had also just there here which who what when where how all any each every one'.split(
    ' '
  )
)

/** Words that negate or make a line conditional, any "n't" form among them: one list for every
 *  check that refuses on negation, so they never drift apart. */
// Any word ending in "nt" or "n't" counts ("shant", "neednt", but also "want" or "parent"): a
// line wrongly kept as is costs nothing, a negation missed can flip a line.
const NEGATING =
  /\b\w+n['’]?t\b|\b(?:not|no|never|none|neither|nor|without|unless|except|avoid|stop|if|instead|cannot)\b/i
/** Words that change how strongly a line holds. */
const MODAL = /\b(?:always|must|only|should|will|would|can|could|may|might|shall)\b/i

/** Whether `text` holds a negation, condition or modal: a line Orca never lets a model rewrite. */
export function hasMeaningWords(text: string): boolean {
  return NEGATING.test(text) || MODAL.test(text)
}

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

/** Whether `text`'s words are, in order, words of `source`: a shortening, never a reorder or a
 *  new word. */
export function isShortening(text: string, source: string): boolean {
  const words = lineWords(text)
  const from = lineWords(source)
  let at = 0
  for (const word of words) {
    while (at < from.length && from[at] !== word) {
      at += 1
    }
    if (at === from.length) {
      return false
    }
    at += 1
  }
  return words.length > 0
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
