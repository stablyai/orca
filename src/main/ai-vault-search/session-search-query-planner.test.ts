import { describe, expect, it } from 'vitest'
import { planSessionSearchQuery, quoteFtsTerm } from './session-search-query-planner'

describe('FTS5 expressions quote every term', () => {
  it('quotes punctuation that would otherwise be syntax', () => {
    expect(quoteFtsTerm('cli.mjs')).toBe('"cli.mjs"')
    expect(quoteFtsTerm('C++')).toBe('"C++"')
    expect(quoteFtsTerm('say "hi"')).toBe('"say ""hi"""')
  })
})

describe('the phrase candidate is the query as typed', () => {
  it('keeps the stop words the OR body drops, because the index holds them', () => {
    const plan = planSessionSearchQuery('why is the relay dropping frames')
    expect(plan.phrase).toEqual(['why', 'is', 'the', 'relay', 'dropping', 'frames'])
    expect(plan.body).toEqual(['relay', 'dropping', 'frames'])
  })
})
