import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatInputLease } from './use-mobile-native-chat-input-lease'

type Lease = ReturnType<typeof useMobileNativeChatInputLease>

describe('useMobileNativeChatInputLease', () => {
  let renderer: ReactTestRenderer | null = null
  let lease: Lease | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

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
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { connected: true }))
      })
      expect(lease?.ready).toBe(false)
      expect(lease?.lockReason).toBe('waiting')
      act(() => lease?.markReady('terminal'))
      expect(lease?.ready).toBe(true)
      expect(lease?.lockReason).toBeNull()

      act(() => lease?.clear())
      expect(lease?.ready).toBe(false)
      act(() => lease?.markReady('terminal'))
      expect(lease?.ready).toBe(true)

      await act(async () => renderer?.update(createElement(Harness, { connected: false })))
      expect(lease?.ready).toBe(false)
      expect(lease?.lockReason).toBe('disconnected')
    } finally {
      consoleSpy.mockRestore()
    }
  })
})
