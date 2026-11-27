import { describe, expect, it } from 'vitest'
import { ProviderRelayCut } from './provider-relay-cut'
import { RelayedProviderContinuation } from '../../provider-relay/relayed-provider-continuation'

describe('a cut ack naming the items it split', () => {
  it('reports the named items with the cut, replaced by each cut, and none for a later spool drop', () => {
    const cut = new ProviderRelayCut()
    cut.record(10, 6, { cut: true, cutKeys: ['a'] })
    expect(cut.report(0)).toEqual({ truncatedThrough: 5, cutKeys: ['a'] })
    // An ack that isn't a cut leaves the last cut's keys alone; the next cut replaces them.
    cut.record(12, undefined, {})
    cut.record(20, 15, { cut: true, cutKeys: ['b'] })
    expect(cut.report(0)).toEqual({ truncatedThrough: 14, cutKeys: ['b'] })
    // A cut that names nothing leaves the reattach to guess.
    cut.record(22, undefined, { cut: true })
    expect(cut.report(0)).toEqual({ truncatedThrough: 22 })
    cut.record(30, 26, { cut: true, cutKeys: ['c'] })
    // The spool dropped kept lines past the client's own cut: those split items no key names.
    expect(cut.report(28)).toEqual({ truncatedThrough: 28 })
    // Reported however far past it a replay starts: an item it split may still be streaming.
    expect(cut.report(0)).toEqual({ truncatedThrough: 25, cutKeys: ['c'] })
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
