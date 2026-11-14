import type { ScreenCondition, TextTest } from './agent-state-rules-schema'
import {
  offsetTerminalSupport,
  type TerminalSupportQuery,
  type TerminalScreenSupportQuery
} from '../../../shared/terminal/output/terminal-content-origin'

export type TextMatcher = (text: string, support?: TerminalSupportQuery) => boolean

type TextTerm = Extract<TextTest, { regex: string } | { contains: string }>

function compileTerm(term: TextTerm): TextMatcher {
  if ('contains' in term) {
    return (text, support) => {
      for (
        let at = text.indexOf(term.contains);
        at !== -1;
        at = text.indexOf(term.contains, at + 1)
      ) {
        if (!support || support(at, at + term.contains.length)) {
          return true
        }
        if (!term.contains) {
          break
        }
      }
      return false
    }
  }
  const pattern = new RegExp(term.regex, term.ignoreCase ? 'i' : '')
  return (text, support) => {
    if (!support) {
      return pattern.test(text)
    }
    const occurrences = new RegExp(pattern.source, `${pattern.flags}g`)
    for (const match of text.matchAll(occurrences)) {
      if (support(match.index, match.index + match[0].length)) {
        return true
      }
    }
    return false
  }
}

export function compileTextTest(test: TextTest): TextMatcher {
  if ('regex' in test || 'contains' in test) {
    return compileTerm(test)
  }
  const all = (test.all ?? []).map(compileTerm)
  const any = (test.any ?? []).map(compileTerm)
  const none = (test.none ?? []).map(compileTerm)
  return (text, support) =>
    all.every((matches) => matches(text, support)) &&
    (any.length === 0 || any.some((matches) => matches(text, support))) &&
    !none.some((matches) => matches(text, support))
}

export type ScreenMatcher = (
  screenLines: readonly string[],
  support?: TerminalScreenSupportQuery
) => boolean

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
  return (screenLines, support) => {
    const lines = screenLines.map((line) => line.trim())
    const queries = screenLines.map((line, row) =>
      support
        ? offsetTerminalSupport(
            (start, end) => support(row, start, end),
            line.length - line.trimStart().length
          )
        : undefined
    )
    let end = lines.length - 1
    const lowestEnd = Math.max(0, lines.length - endsWithinBottom)
    for (; end >= lowestEnd; end--) {
      if (!lastRow?.matches(lines[end]!, queries[end])) {
        continue
      }
      let cursor = end - 1
      let matched = true
      for (const row of rowsUpward) {
        if (row.matches(lines[cursor] ?? '', queries[cursor])) {
          cursor--
        } else if (!row.optional) {
          matched = false
          break
        }
      }
      return (
        matched &&
        (noneAbove === null ||
          !lines
            .slice(0, Math.max(0, cursor + 1))
            .some((line, index) => noneAbove(line, queries[index])))
      )
    }
    return false
  }
}
