// How alike two memory lines are by their key words, so a line a tidy-up moved can't come back
// renamed at a turn end.

const STOPWORDS = new Set(
  'a an the and or but of to in on at for by with from as is are was were be been being it its this that these those then than so if into over under via per their they them our we you your i he she his her has have had also just there here which who what when where how all any each every one'.split(
    ' '
  )
)

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

export const keyWords = (text: string): Set<string> =>
  new Set(
    lineWords(text)
      .filter((word) => !STOPWORDS.has(word))
      .map(stem)
  )

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
