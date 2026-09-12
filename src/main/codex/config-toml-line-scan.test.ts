import { describe, expect, it } from 'vitest'
import { parse } from 'smol-toml'
import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

const cases = ['"', "'"].flatMap((quote) =>
  [3, 4, 5].flatMap((closingQuotes) =>
    ['', '\n'].map((newline) => ({ quote, closingQuotes, newline }))
  )
)

describe.each(cases)(
  'array multiline $quote with $closingQuotes closing quotes and newline=$newline',
  ({ quote, closingQuotes, newline }) => {
    it('recognizes the table after the closed array as structure', () => {
      const source = `roots = [${quote.repeat(3)}${newline}foo${quote.repeat(closingQuotes)}]\n[next]\nkeep = "yes"\n`
      expect(parse(source)).toEqual({
        roots: [`foo${quote.repeat(closingQuotes - 3)}`],
        next: { keep: 'yes' }
      })
      let state = createTomlLineScanState()
      for (const line of source.slice(0, source.indexOf('[next]')).split('\n')) {
        state = updateTomlLineScanState(state, line)
      }
      expect(isTomlStructuralLine(state)).toBe(true)
    })
  }
)
