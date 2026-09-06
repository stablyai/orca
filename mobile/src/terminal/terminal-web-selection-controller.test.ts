import { describe, expect, it } from 'vitest'
import { terminalSelectionLength, terminalWordSelection } from './terminal-web-selection-controller'

function lineFromText(text: string) {
  return {
    length: text.length,
    getCell: (col: number) => ({
      getChars: () => text[col] ?? ''
    })
  } as Parameters<typeof terminalWordSelection>[0]
}

describe('hosted terminal selection', () => {
  it('selects the same path-oriented word characters as the native terminal', () => {
    expect(
      terminalWordSelection(lineFromText('open src/app.ts:12 now'), { col: 10, row: 4 })
    ).toEqual({
      start: { col: 5, row: 4 },
      end: { col: 17, row: 4 }
    })
  })

  it('keeps punctuation outside a seeded word selection', () => {
    expect(terminalWordSelection(lineFromText('(README.md),'), { col: 3, row: 0 })).toEqual({
      start: { col: 1, row: 0 },
      end: { col: 9, row: 0 }
    })
  })

  it('calculates xterm selection lengths across buffer rows', () => {
    expect(
      terminalSelectionLength(
        {
          start: { col: 70, row: 10 },
          end: { col: 5, row: 12 }
        },
        80
      )
    ).toBe(96)
  })
})
