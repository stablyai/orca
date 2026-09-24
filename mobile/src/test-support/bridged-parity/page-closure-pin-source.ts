import { readFileSync } from 'node:fs'

/**
 * A pin table read back out of its file's own text, which a spread cannot launder.
 *
 * A composed closure module spreads the table it inherits, so comparing the two objects is vacuous:
 * a hand-edited inherited entry is read back as the original's and agrees with itself. Reading the
 * committed source is the independent half of that comparison, and it is the same half for every
 * series — C2 and C3 each carried a byte-for-byte copy of this before it moved here.
 *
 * The formatter wraps a long entry onto two lines, an id alone and its verdict indented beneath, so
 * both forms are handled: a reader that saw only the single-line form is what once dropped three
 * `result-absent-stream-release` pins from C5's derivation while its mismatch list stayed empty.
 */
export function pinsFromSource(path: string): Record<string, Record<string, string>> {
  const table: Record<string, Record<string, string>> = {}
  let family: Record<string, string> | undefined
  let wrappedId: string | undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const opened = /^ {2}'([^']+)': \{/.exec(line)?.[1]
    if (opened !== undefined) {
      family = {}
      table[opened] = family
      wrappedId = undefined
      continue
    }
    const whole = /^ {4}'([^']+)': '([^']+)'/.exec(line)
    const verdict = whole?.[2]
    if (whole?.[1] !== undefined && verdict !== undefined && family !== undefined) {
      family[whole[1]] = verdict
      wrappedId = undefined
      continue
    }
    const wrapped = /^\s+'([^']+)'/.exec(line)?.[1]
    if (wrappedId !== undefined && wrapped !== undefined && family !== undefined) {
      family[wrappedId] = wrapped
      wrappedId = undefined
      continue
    }
    wrappedId = /^ {4}'([^']+)':\s*$/.exec(line)?.[1]
  }
  return table
}
