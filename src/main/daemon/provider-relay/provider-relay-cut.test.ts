import { describe, expect, it } from 'vitest'
import { ProviderRelayCut } from './provider-relay-cut'
import { RelayedProviderContinuation } from '../../provider-relay/relayed-provider-continuation'

describe('a cut ack naming the items it split', () => {
  it('reports the named items with where the client saved through, replaced by each naming ack, and none past a spool drop', () => {
    const cut = new ProviderRelayCut()
    cut.record(10, 6, { cut: true, cutKeys: ['a'], savedThrough: 10 })
    expect(cut.report(0)).toEqual({ truncatedThrough: 5, cutKeys: ['a'], savedThrough: 10 })
    // An ack naming nothing leaves the last keys alone; the next cut replaces them.
    cut.record(12, undefined, {})
    cut.record(20, 15, { cut: true, cutKeys: ['b'], savedThrough: 20 })
    expect(cut.report(0)).toEqual({ truncatedThrough: 14, cutKeys: ['b'], savedThrough: 20 })
    // A cut that names nothing leaves the reattach to guess.
    cut.record(22, undefined, { cut: true })
    expect(cut.report(0)).toEqual({ truncatedThrough: 22 })
    cut.record(30, 26, { cut: true, cutKeys: ['c'], savedThrough: 30 })
    // The spool dropped kept lines past the client's own cut: those split items no key names.
    expect(cut.report(28)).toEqual({ truncatedThrough: 28 })
    // Reported however far past it a replay starts: an item it split may still be streaming.
    expect(cut.report(0)).toEqual({ truncatedThrough: 25, cutKeys: ['c'], savedThrough: 30 })
    // An ack that isn't a cut may name what a replay from its floor would split.
    cut.record(32, 31, { cutKeys: ['d'], savedThrough: 31 })
    expect(cut.report(0)).toEqual({ truncatedThrough: 25, cutKeys: ['d'], savedThrough: 31 })
    // Only what the client said it saved: an ack past unsaved text never moves it.
    cut.record(40, 31, { cutKeys: ['d'] })
    expect(cut.report(0)).toEqual({ truncatedThrough: 25, cutKeys: ['d'], savedThrough: 31 })
    expect(new ProviderRelayCut().report(0)).toEqual({})
  })

  it('moves exactly the named items to continuation rows, and guesses only without names', () => {
    const hook = {
      item: (line: string) => {
        const [key, kind] = line.split(':')
        return { key: key!, start: kind === 'start', end: kind === 'end' }
      },
      rekey: (line: string, tag: string) => `${tag}/${line}`,
      start: (_line: string, tag: string) => `${tag}/start`
    }
    const named = new RelayedProviderContinuation(hook, 'r', 5, 9, null, new Set(['a']))
    expect(named.lines(6, 'a:delta', undefined)).toEqual(['relay:r:6/a:delta'])
    // b's start was before the cursor but the cut didn't split it: it stays on its own row.
    expect(named.lines(7, 'b:delta', undefined)).toEqual(['b:delta'])
    const guessing = new RelayedProviderContinuation(hook, 'r', 5, 9)
    expect(guessing.lines(7, 'b:delta', undefined)).toEqual(['relay:r:7/b:delta'])
  })
})
