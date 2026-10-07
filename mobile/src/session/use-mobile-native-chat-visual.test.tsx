import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatVisualRead } from './mobile-native-chat-visual-read'

const reads = vi.hoisted(() => {
  const next: MobileNativeChatVisualRead[] = []
  return { next, calls: 0 }
})

vi.mock('./mobile-native-chat-visual-read', () => ({
  cachedMobileNativeChatVisual: () => null,
  readMobileNativeChatVisual: () => {
    reads.calls += 1
    return Promise.resolve(reads.next.shift() ?? { kind: 'unreachable' })
  }
}))

import {
  useMobileNativeChatVisual,
  type MobileNativeChatVisualState
} from './use-mobile-native-chat-visual'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read module is mocked; the client is only an identity here.
const source = { client: {} as RpcClient, sessionId: 'session-1' }

let latest: { state: MobileNativeChatVisualState; retry: () => void } | null = null
function Probe() {
  latest = useMobileNativeChatVisual(source, 'chart.html')
  return null
}

describe('useMobileNativeChatVisual', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    reads.next = []
    reads.calls = 0
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    latest = null
    vi.useRealTimers()
  })

  async function mount(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Probe))
    })
  }

  it('re-asks a bounded number of times when the host does not answer, then shows unavailable', async () => {
    await mount()
    expect(reads.calls).toBe(1)
    for (const delay of [1_500, 5_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
    }
    expect(reads.calls).toBe(3)
    expect(latest?.state).toEqual({ kind: 'unavailable' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(reads.calls).toBe(3)
  })

  it('does not latch a failure: a retry asks again and can succeed', async () => {
    reads.next = [{ kind: 'refused' }, { kind: 'ready', html: '<p>', revision: 'a'.repeat(32) }]
    await mount()
    expect(latest?.state).toEqual({ kind: 'unavailable' })
    await act(async () => {
      latest?.retry()
    })
    expect(reads.calls).toBe(2)
    expect(latest?.state).toEqual({ kind: 'ready', html: '<p>', revision: 'a'.repeat(32) })
  })

  it('stops re-asking after unmount', async () => {
    await mount()
    act(() => renderer?.unmount())
    renderer = null
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(reads.calls).toBe(1)
  })
})
