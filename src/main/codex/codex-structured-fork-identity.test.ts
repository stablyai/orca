import { describe, expect, it } from 'vitest'
import {
  assertCodexForkedIdentities,
  assertCodexForkedTurnIds
} from './codex-structured-fork-identity'
const fork = {
  source: { provider: 'codex', threadId: 'parent' },
  throughId: 'selected',
  retainedItemIds: ['codex:parent:previous:0', 'codex:parent:selected:0', 'codex:parent:selected:1']
} as const

describe('Codex fork retained identity proof', () => {
  it('accepts provider-listed turns and ordinals retaining every copied identity', () => {
    expect(() =>
      assertCodexForkedIdentities('child', fork, [
        { provider: 'codex', threadId: 'child', turnId: 'previous', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'selected', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'selected', ordinal: 1 }
      ])
    ).not.toThrow()
  })
  it('refuses new provider turn IDs instead of publishing identities that duplicate on hydration', () => {
    expect(() =>
      assertCodexForkedIdentities('child', fork, [
        { provider: 'codex', threadId: 'child', turnId: 'new-previous', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'new-selected', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'new-selected', ordinal: 1 }
      ])
    ).toThrow('proof-mismatch')
  })
  it('refuses missing provider items even when the selected turn survives', () => {
    expect(() =>
      assertCodexForkedIdentities('child', fork, [
        { provider: 'codex', threadId: 'child', turnId: 'previous', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'selected', ordinal: 0 }
      ])
    ).toThrow('proof-mismatch')
  })

  it('accepts provider items from turns a bounded journal never retained', () => {
    expect(() =>
      assertCodexForkedIdentities('child', fork, [
        { provider: 'codex', threadId: 'child', turnId: 'compacted-away', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'previous', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'selected', ordinal: 0 },
        { provider: 'codex', threadId: 'child', turnId: 'selected', ordinal: 1 }
      ])
    ).not.toThrow()
  })
})

// `turnIds` arrives newest-first.
describe('Codex fork retained turn proof', () => {
  it('accepts a forked thread holding turns the bounded journal dropped', () => {
    expect(() =>
      assertCodexForkedTurnIds(fork, ['selected', 'previous', 'older', 'ancient'])
    ).not.toThrow()
  })

  it('refuses a retained turn the fork dropped', () => {
    expect(() => assertCodexForkedTurnIds(fork, ['selected', 'older'])).toThrow('proof-mismatch')
  })

  it('refuses a fork that renumbered a retained turn', () => {
    expect(() => assertCodexForkedTurnIds(fork, ['selected', 'new-previous'])).toThrow(
      'proof-mismatch'
    )
  })

  it('refuses a fork that reordered the retained turns', () => {
    const ordered = {
      ...fork,
      throughId: 'c',
      retainedItemIds: ['codex:parent:a:0', 'codex:parent:b:0', 'codex:parent:c:0']
    } as const
    expect(() => assertCodexForkedTurnIds(ordered, ['c', 'a', 'b'])).toThrow('proof-mismatch')
  })

  it('refuses a fork that kept turns past the selected one', () => {
    expect(() => assertCodexForkedTurnIds(fork, ['later', 'selected', 'previous'])).toThrow(
      'proof-mismatch'
    )
  })

  it('refuses an empty forked thread', () => {
    expect(() => assertCodexForkedTurnIds(fork, [])).toThrow('proof-mismatch')
  })
})
