import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mobileNativeChatComposerPlaceholder,
  useMobileNativeChatInputLease,
  useSettledMobileNativeChatInputLock
} from './use-mobile-native-chat-input-lease'

type Lease = ReturnType<typeof useMobileNativeChatInputLease>

describe('useMobileNativeChatInputLease', () => {
  let renderer: ReactTestRenderer | null = null
  let lease: Lease | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    lease = null
  })

  function Harness({ connected }: { connected: boolean }): null {
    lease = useMobileNativeChatInputLease({ activeHandle: 'terminal', connected })
    return null
  }

  it('unlocks only after acknowledgement and clears on disconnect', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { connected: true }))
    })
    expect(lease?.ready).toBe(false)
    expect(lease?.lockReason).toBe('waiting')
    act(() => lease?.markReady('terminal'))
    expect(lease?.ready).toBe(true)
    expect(lease?.lockReason).toBeNull()

    act(() => {
      lease?.clear()
    })
    expect(lease?.ready).toBe(false)
    act(() => lease?.markReady('terminal'))
    expect(lease?.ready).toBe(true)

    await act(async () => renderer?.update(createElement(Harness, { connected: false })))
    expect(lease?.ready).toBe(false)
    expect(lease?.lockReason).toBe('disconnected')
  })

  it('reports whether a clear actually dropped a lease', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { connected: true }))
    })
    // The route reads this to tell a real teardown from one React never sees.
    expect(lease?.clear('terminal')).toBe(false)
    expect(lease?.clear()).toBe(false)

    act(() => lease?.markReady('terminal'))
    let dropped: boolean | undefined
    act(() => {
      dropped = lease?.clear('terminal')
    })
    expect(dropped).toBe(true)
    expect(lease?.ready).toBe(false)
    expect(lease?.clear('terminal')).toBe(false)

    act(() => lease?.markReady('other'))
    expect(lease?.clear()).toBe(true)
  })
})

describe('useSettledMobileNativeChatInputLock', () => {
  let renderer: ReactTestRenderer | null = null
  let settled: ReturnType<typeof useSettledMobileNativeChatInputLock> | undefined

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  function Harness({ reason }: { reason: 'waiting' | 'disconnected' | null }): null {
    settled = useSettledMobileNativeChatInputLock(reason)
    return null
  }

  it('holds each edge until the lease has stopped flapping', () => {
    vi.useFakeTimers()
    act(() => {
      renderer = create(createElement(Harness, { reason: 'waiting' }))
    })
    expect(settled).toBeNull()
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(settled).toBe('waiting')

    // A brief unlock that reverts inside the settle window never reaches the composer.
    act(() => renderer?.update(createElement(Harness, { reason: null })))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    act(() => renderer?.update(createElement(Harness, { reason: 'disconnected' })))
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(settled).toBe('disconnected')

    act(() => renderer?.update(createElement(Harness, { reason: null })))
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(settled).toBeNull()
  })
})

describe("the phone chat composer's placeholder", () => {
  it('says a message runs after the stop while the chat reads Stopping', () => {
    expect(mobileNativeChatComposerPlaceholder(null, 'queue')).toBe(
      'Queue a message to run after the stop'
    )
    // Where the host does not queue sends, it holds the message until the stop lands.
    expect(mobileNativeChatComposerPlaceholder(null, 'send')).toBe(
      'Send a message to run after the stop'
    )
  })

  it('reads as usual otherwise', () => {
    expect(mobileNativeChatComposerPlaceholder(null, undefined)).toBe('Message, @files, /commands')
  })

  it('says why the composer is locked first', () => {
    expect(mobileNativeChatComposerPlaceholder('disconnected', 'queue')).toBe('Reconnecting…')
    expect(mobileNativeChatComposerPlaceholder('waiting', 'queue')).toBe('Waiting for terminal…')
  })
})
