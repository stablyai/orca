import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileAttachmentInputLeaseGate } from './use-mobile-attachment-input-lease-gate'

type Gate = (targetHandle: string) => Promise<boolean>

describe('useMobileAttachmentInputLeaseGate', () => {
  let renderer: ReactTestRenderer | null = null
  let errorSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    const original = console.error
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...(args as Parameters<typeof console.error>))
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
    errorSpy?.mockRestore()
  })

  function renderGate(args: {
    connState: { current: string }
    activeHandle: { current: string | null }
    tabType: { current: string | null }
    leaseReady: { current: boolean }
    showToast: (message: string, durationMs?: number) => void
  }): { gate: () => Gate } {
    let gate: Gate = () => Promise.resolve(false)
    function Probe(): null {
      gate = useMobileAttachmentInputLeaseGate({
        flushPendingLiveInputBeforeExternalSend: () => Promise.resolve(true),
        connStateRef: args.connState,
        activeHandleRef: args.activeHandle,
        activeSessionTabTypeRef: args.tabType,
        nativeChatInputLeaseReadyRef: args.leaseReady,
        showToast: args.showToast
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
    return { gate: () => gate }
  }

  function baseRefs(): {
    connState: { current: string }
    activeHandle: { current: string | null }
    tabType: { current: string | null }
    leaseReady: { current: boolean }
  } {
    return {
      connState: { current: 'connected' },
      activeHandle: { current: 'terminal-1' },
      tabType: { current: 'terminal' },
      leaseReady: { current: true }
    }
  }

  it('passes immediately when the lease is ready and the target is active', async () => {
    const refs = baseRefs()
    const showToast = vi.fn()
    const { gate } = renderGate({ ...refs, showToast })

    await expect(gate()('terminal-1')).resolves.toBe(true)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('waits out a lease-not-ready window and then sends', async () => {
    const refs = baseRefs()
    refs.leaseReady.current = false
    const showToast = vi.fn()
    const { gate } = renderGate({ ...refs, showToast })

    const result = gate()('terminal-1')
    await vi.advanceTimersByTimeAsync(200)
    refs.leaseReady.current = true
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toBe(true)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('surfaces a toast when the lease never recovers', async () => {
    const refs = baseRefs()
    refs.leaseReady.current = false
    const showToast = vi.fn()
    const { gate } = renderGate({ ...refs, showToast })

    const result = gate()('terminal-1')
    await vi.advanceTimersByTimeAsync(3200)
    await expect(result).resolves.toBe(false)
    expect(showToast).toHaveBeenCalledWith('Attach failed (reconnecting)', 1500)
  })

  it('drops silently when the target changes while waiting for the lease', async () => {
    const refs = baseRefs()
    refs.leaseReady.current = false
    const showToast = vi.fn()
    const { gate } = renderGate({ ...refs, showToast })

    const result = gate()('terminal-1')
    // Mid-wait the user switches tabs: the lease recovers, but for a different
    // target — the attach must not proceed against the stale handle.
    await vi.advanceTimersByTimeAsync(200)
    refs.activeHandle.current = 'terminal-2'
    refs.leaseReady.current = true
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('drops silently when the connection is lost while waiting', async () => {
    const refs = baseRefs()
    refs.leaseReady.current = false
    const showToast = vi.fn()
    const { gate } = renderGate({ ...refs, showToast })

    const result = gate()('terminal-1')
    await vi.advanceTimersByTimeAsync(200)
    refs.connState.current = 'reconnecting'
    await vi.advanceTimersByTimeAsync(3200)
    await expect(result).resolves.toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })
})
