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

describe('the group a paired desktop shows, beside the window', () => {
  it('the latest report wins, whichever connection or window sent it', () => {
    const facts = new ActiveGroupViewFacts()
    facts.mergeFromClient('desktop-a', { wt: 'gA' })
    facts.mergeFromClient('desktop-b', { wt: 'gB' })
    expect(facts.groupFor('wt', () => 'saved')).toBe('gB')
    facts.mergeFromClient('desktop-a', { wt: 'gA2' })
    expect(facts.groupFor('wt', () => 'saved')).toBe('gA2')
    facts.merge({ wt: 'gW' })
    expect(facts.groupFor('wt', () => 'saved')).toBe('gW')
    facts.mergeFromClient('desktop-b', { wt: 'gB2' })
    expect(facts.groupFor('wt', () => 'saved')).toBe('gB2')
  })

  it("a closed connection's report goes: the other desktop's counts, else the saved view", () => {
    const facts = new ActiveGroupViewFacts()
    facts.mergeFromClient('desktop-a', { wt: 'gA' })
    facts.mergeFromClient('desktop-b', { wt: 'gB' })
    facts.dropClient('desktop-b')
    expect(facts.groupFor('wt', () => 'saved')).toBe('gA')
    facts.dropClient('desktop-a')
    expect(facts.groupFor('wt', () => 'saved')).toBe('saved')
  })

  it("a closed connection leaves the window's report", () => {
    const facts = new ActiveGroupViewFacts()
    facts.merge({ wt: 'gW' })
    facts.mergeFromClient('desktop-a', { wt: 'gA' })
    facts.dropClient('desktop-a')
    expect(facts.groupFor('wt', () => 'saved')).toBe('gW')
  })

  it("is first only for a connection's first report", () => {
    const facts = new ActiveGroupViewFacts()
    expect(facts.mergeFromClient('desktop-a', { wt: 'g1' })).toBe(true)
    expect(facts.mergeFromClient('desktop-a', { wt: 'g2' })).toBe(false)
    facts.dropClient('desktop-a')
    expect(facts.mergeFromClient('desktop-a', {})).toBe(true)
  })
})

describe("a desktop's refresh: its view re-sent after a reconnect", () => {
  it("never displaces another desktop's live report", () => {
    const facts = new ActiveGroupViewFacts()
    facts.mergeFromClient('desktop-a', { wt: 'gA' })
    facts.mergeFromClient('desktop-b', { wt: 'gB' }, true)
    expect(facts.groupFor('wt', () => 'saved')).toBe('gA')
  })

  it('counts as live without the flag', () => {
    const facts = new ActiveGroupViewFacts()
    facts.mergeFromClient('desktop-a', { wt: 'gA' })
    facts.mergeFromClient('desktop-b', { wt: 'gB' })
    expect(facts.groupFor('wt', () => 'saved')).toBe('gB')
  })

  it("replaces the connection's own entry, and beats the saved view", () => {
    const facts = new ActiveGroupViewFacts()
    facts.mergeFromClient('desktop-a', { wt: 'gA' })
    facts.mergeFromClient('desktop-a', { wt: 'gA2' }, true)
    expect(facts.groupFor('wt', () => 'saved')).toBe('gA2')
  })

  it('loses to a later live report of the window, and the later refresh wins among refreshes', () => {
    const facts = new ActiveGroupViewFacts()
    facts.mergeFromClient('desktop-a', { wt: 'gA' }, true)
    facts.mergeFromClient('desktop-b', { wt: 'gB' }, true)
    expect(facts.groupFor('wt', () => 'saved')).toBe('gB')
    facts.merge({ wt: 'gW' })
    facts.mergeFromClient('desktop-a', { wt: 'gA2' }, true)
    expect(facts.groupFor('wt', () => 'saved')).toBe('gW')
  })
})

describe("a refresh on the connection's own live report", () => {
  it('keeps its rank: a resubscribe does not hand the workspace to an older report', () => {
    const facts = new ActiveGroupViewFacts()
    facts.mergeFromClient('desktop-b', { wt: 'g1' })
    facts.mergeFromClient('desktop-a', { wt: 'g2' })
    facts.mergeFromClient('desktop-a', { wt: 'g2' }, true)
    expect(facts.groupFor('wt', () => 'saved')).toBe('g2')
  })

  it('takes a changed group at the rank it had', () => {
    const facts = new ActiveGroupViewFacts()
    facts.mergeFromClient('desktop-b', { wt: 'g1' })
    facts.mergeFromClient('desktop-a', { wt: 'g2' })
    facts.mergeFromClient('desktop-a', { wt: 'g3' }, true)
    expect(facts.groupFor('wt', () => 'saved')).toBe('g3')
    facts.mergeFromClient('desktop-b', { wt: 'g4' })
    expect(facts.groupFor('wt', () => 'saved')).toBe('g4')
  })
})
