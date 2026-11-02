import type { ScreenCondition, TextTest } from './agent-state-rules-schema'

export type TextMatcher = (text: string) => boolean

type TextTerm = Extract<TextTest, { regex: string } | { contains: string }>

function compileTerm(term: TextTerm): TextMatcher {
  if ('contains' in term) {
    return (text) => text.includes(term.contains)
  }
  const pattern = new RegExp(term.regex, term.ignoreCase ? 'i' : '')
  return (text) => pattern.test(text)
}

export function compileTextTest(test: TextTest): TextMatcher {
  if ('regex' in test || 'contains' in test) {
    return compileTerm(test)
  }
  const all = (test.all ?? []).map(compileTerm)
  const any = (test.any ?? []).map(compileTerm)
  const none = (test.none ?? []).map(compileTerm)
  return (text) =>
    all.every((matches) => matches(text)) &&
    (any.length === 0 || any.some((matches) => matches(text))) &&
    !none.some((matches) => matches(text))
}

export type ScreenMatcher = (screenLines: readonly string[]) => boolean

export function compileScreenCondition(screen: ScreenCondition): ScreenMatcher {
  if (!screen.rows) {
    return () => true
  }
  const rows = screen.rows.map((row) =>
    'optional' in row
      ? { matches: compileTextTest(row.optional), optional: true }
      : { matches: compileTextTest(row), optional: false }
  )
  const endsWithinBottom = screen.endsWithinBottom ?? 1
  const noneAbove = screen.noneAbove ? compileTextTest(screen.noneAbove) : null
  const lastRow = rows.at(-1)
  const rowsUpward = rows.slice(0, -1).toReversed()
  return (screenLines) => {
    const lines = screenLines.map((line) => line.trim())
    let end = lines.length - 1
    const lowestEnd = Math.max(0, lines.length - endsWithinBottom)
    while (end >= lowestEnd && !lastRow?.matches(lines[end])) {
      end -= 1
    }
    if (end < lowestEnd) {
      return false
    }
    let cursor = end - 1
    for (const row of rowsUpward) {
      if (row.matches(lines[cursor] ?? '')) {
        cursor -= 1
      } else if (!row.optional) {
        return false
      }
    }
    return noneAbove === null || !lines.slice(0, Math.max(0, cursor + 1)).some(noneAbove)
  }
}
