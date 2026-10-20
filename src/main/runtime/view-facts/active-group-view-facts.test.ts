import { describe, expect, it } from 'vitest'
import { ActiveGroupViewFacts } from './active-group-view-facts'

describe("the window's active group, as main keeps it", () => {
  it("is the saved view's until a window reports one", () => {
    const facts = new ActiveGroupViewFacts()
    expect(facts.groupFor('wt', () => 'saved')).toBe('saved')
    facts.merge({ wt: 'live' })
    expect(facts.groupFor('wt', () => 'saved')).toBe('live')
  })

  it('keeps a workspace a later report does not name, and a report without the field changes nothing', () => {
    const facts = new ActiveGroupViewFacts()
    facts.merge({ a: 'g1' })
    facts.merge({ b: 'g2' })
    facts.merge(undefined)
    expect(facts.groupFor('a', () => null)).toBe('g1')
    expect(facts.groupFor('b', () => null)).toBe('g2')
  })

  it('is none once the window reports none, not the saved one', () => {
    const facts = new ActiveGroupViewFacts()
    facts.merge({ a: 'g1' })
    facts.merge({ a: null })
    expect(facts.groupFor('a', () => 'saved')).toBeUndefined()
  })
})
