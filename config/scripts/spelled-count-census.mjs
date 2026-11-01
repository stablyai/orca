// Compare every spelled count before selected phrases with actual table length; stale duplicates fail even if one spelling is correct (#22072).
// Ignore wraps/comment markers, collapse repeated correct words, and treat missing number as empty mismatch.

export const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen'
]

/** Comment markers and their wrapping dropped, so a phrase is found wherever the line broke. */
function unwrapped(source) {
  return source.replace(/\n\s*(\/\/|\*)/g, ' ').replace(/\s+/g, ' ')
}

/** Every number word that appears before `words` in this source, in the order they are written. */
export function numberWordsBefore(source, words) {
  return [...unwrapped(source).matchAll(new RegExp(`\\b([A-Za-z]+) ${words}\\b`, 'g'))]
    .map((match) => match[1].toLowerCase())
    .filter((word) => NUMBER_WORDS.includes(word))
}

// Return phrase/count rows so caller’s assertion identifies which prose claim drifted.
export function spelledCountsAgainstTables(source, rows) {
  return rows.map(({ precedes, counted }) => {
    const word = NUMBER_WORDS[counted]
    if (word === undefined) {
      throw new Error(`[spelled-count-census] no number word for ${String(counted)}`)
    }
    return { precedes, spelled: [...new Set(numberWordsBefore(source, precedes))], counts: [word] }
  })
}
