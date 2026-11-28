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
      .replace(/\u2019/g, "'")
      .match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? []
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

/** How much of `line`'s key words `words` holds: 1 when every one is there. A line with no key
 *  words (all stopwords, or a script written without spaces) counts as held only when `words`
 *  contains it whole. */
export function lineCoverage(line: string, words: string): number {
  const wanted = keyWords(line)
  if (wanted.size === 0) {
    const whole = line.replace(/\s+/g, ' ').trim().toLowerCase()
    return whole !== '' && words.replace(/\s+/g, ' ').toLowerCase().includes(whole) ? 1 : 0
  }
  const have = keyWords(words)
  // Scripts written without spaces read as one long word: found inside the text counts too.
  const text = words.toLowerCase()
  const held = (word: string): boolean =>
    have.has(word) || ([...word].some((char) => char.charCodeAt(0) > 127) && text.includes(word))
  return [...wanted].filter(held).length / wanted.size
}
