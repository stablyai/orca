import { describe, expect, it } from 'vitest'
import { shouldPruneTerminalHandle } from './mobile-terminal-prune-decision'

describe('shouldPruneTerminalHandle', () => {
  it('prunes a handle the list no longer reports while chat is closed', () => {
    expect(
      shouldPruneTerminalHandle({
        handle: 'term-1',
        liveHandles: new Set(['term-2']),
        showNativeChat: false,
        activeHandle: 'term-1'
      })
    ).toBe(true)
  })

  it('retains the chat-covered handle when the list omits it (#10681)', () => {
    // Graph reloads can omit every handle while the covered stream still owns the composer input lease.
    expect(
      shouldPruneTerminalHandle({
        handle: 'term-1',
        liveHandles: new Set(),
        showNativeChat: true,
        activeHandle: 'term-1'
      })
    ).toBe(false)
  })

  it('still prunes an absent handle that chat is not covering', () => {
    expect(
      shouldPruneTerminalHandle({
        handle: 'term-1',
        liveHandles: new Set(['term-2']),
        showNativeChat: true,
        activeHandle: 'term-2'
      })
    ).toBe(true)
  })

  it('keeps a handle the list still reports, whatever chat is doing', () => {
    for (const showNativeChat of [true, false]) {
      expect(
        shouldPruneTerminalHandle({
          handle: 'term-1',
          liveHandles: new Set(['term-1']),
          showNativeChat,
          activeHandle: null
        })
      ).toBe(false)
    }
  })
})
