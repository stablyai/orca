/**
 * Counts a comment spells out, read back and compared with the table each is a count of.
 *
 * Prose is where a count drifts. #22072 removed one grant from the session route and left
 * "Fourteen grants" and "the four audio verbs" standing in five files, none of which a reader can
 * tell from a fact. Naming the table in the sentence does not help either: the number is still a
 * copy, and a copy is what goes stale.
 *
 * A row names the words a number precedes. Every number word found before them anywhere in the
 * file has to be the one the table counts, so a second spelling left behind fails too rather than
 * passing on the first correct hit, and a phrase rewrapped at a different column still matches.
 * Repeats of the right word collapse, because a claim restated is still one claim; a phrase with no
 * number before it anywhere reads as the empty list, which no table count matches.
 */

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

/**
 * One entry per row: what the prose spells, and what the table counts, ready to compare.
 *
 * Returned rather than asserted so the caller's failure names the phrase, which is the only thing
 * that says where in the file to look.
 */
export function spelledCountsAgainstTables(source, rows) {
  return rows.map(({ precedes, counted }) => {
    const word = NUMBER_WORDS[counted]
    if (word === undefined) {
      throw new Error(`[spelled-count-census] no number word for ${String(counted)}`)
    }
    return { precedes, spelled: [...new Set(numberWordsBefore(source, precedes))], counts: [word] }
  })
}
