import { readFileSync } from 'node:fs'

// Read literal source pins so spreads cannot hide edited inherited entries; parse formatter-wrapped entries as well as single lines.
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
