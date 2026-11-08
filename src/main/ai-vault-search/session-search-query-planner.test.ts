import { describe, expect, it } from 'vitest'
import { quoteFtsTerm } from './session-search-query-planner'

describe('FTS5 expressions quote every term', () => {
  it('quotes punctuation that would otherwise be syntax', () => {
    expect(quoteFtsTerm('cli.mjs')).toBe('"cli.mjs"')
    expect(quoteFtsTerm('C++')).toBe('"C++"')
    expect(quoteFtsTerm('say "hi"')).toBe('"say ""hi"""')
  })
})
