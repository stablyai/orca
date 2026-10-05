import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindMobileChatPairRoute,
  getMobileChatPairWrites,
  mobileChatPairKeyId,
  mobileChatPairKeysInScope,
  readMobileChatPairOverlay,
  type MobileChatPairRouteBinding
} from './mobile-session-chat-pair-writes'

const key = { hostId: 'h', worktreeId: 'w', parentTabId: 'P' }

function route(): MobileChatPairRouteBinding & { sends: number; failures: number } {
  const binding = {
    sends: 0,
    failures: 0,
    ready: () => true,
    readHostPair: () => ({}),
    // Why never settling: the overlay must stay up while the write is in flight.
    send: vi.fn(() => {
      binding.sends += 1
      return new Promise<never>(() => {})
    }),
    reportFailure: () => {
      binding.failures += 1
    }
  }
  return binding
}

function submitChat(): void {
  getMobileChatPairWrites().submit(
    key,
    { viewMode: 'chat', leafId: 'A' },
    { viewMode: 'chat', chatLeafId: 'A' }
  )
}

describe('two session routes mounted for one worktree (history -> resume pushes a second) (R5-F1)', () => {
  const unbinds: (() => void)[] = []
  afterEach(() => {
    for (const unbind of unbinds.splice(0)) {
      unbind()
    }
  })

  it('keeps the first route working after the pushed one unmounts', async () => {
    const first = route()
    unbinds.push(bindMobileChatPairRoute('h', 'w', first))
    const second = route()
    bindMobileChatPairRoute('h', 'w', second)()
    submitChat()
    await Promise.resolve()
    expect(first.sends).toBe(1)
    expect(readMobileChatPairOverlay().get(mobileChatPairKeyId(key))).toEqual({
      viewMode: 'chat',
      chatLeafId: 'A'
    })
  })

  it("keeps the other route's pending click when one route unmounts, and drops it with the last", () => {
    const unbindFirst = bindMobileChatPairRoute('h', 'w', route())
    const unbindSecond = bindMobileChatPairRoute('h', 'w', route())
    submitChat()
    unbindFirst()
    expect(mobileChatPairKeysInScope('h', 'w')).toHaveLength(1)
    unbindSecond()
    expect(mobileChatPairKeysInScope('h', 'w')).toEqual([])
    expect(readMobileChatPairOverlay().has(mobileChatPairKeyId(key))).toBe(false)
  })
})
