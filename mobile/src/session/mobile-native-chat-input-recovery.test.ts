import { describe, expect, it, vi } from 'vitest'
import { recoverMobileNativeChatInput } from './mobile-native-chat-input-recovery'

function createRecoveryHarness() {
  let connected = true
  let handle: string | null = 'term-1'
  let sessionTabId: string | null = 'tab-1'
  let ready = false
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(() => {
    ready = true
  })
  const reconcile = vi.fn(async () => undefined)

  return {
    args: {
      rejectedHandle: 'term-1',
      expectedSessionTabId: 'tab-1',
      isConnected: () => connected,
      getActiveHandle: () => handle,
      getActiveSessionTabId: () => sessionTabId,
      isActiveTerminal: () => true,
      isLeaseReady: () => ready,
      reconcile,
      unsubscribe,
      subscribe
    },
    reconcile,
    setConnected: (value: boolean) => {
      connected = value
    },
    setHandle: (value: string | null) => {
      handle = value
    },
    setReady: (value: boolean) => {
      ready = value
    },
    setSessionTabId: (value: string | null) => {
      sessionTabId = value
    },
    subscribe,
    unsubscribe
  }
}

describe('recoverMobileNativeChatInput', () => {
  it('refreshes session state and renews the current input subscription', async () => {
    const harness = createRecoveryHarness()

    await expect(recoverMobileNativeChatInput(harness.args)).resolves.toBe(true)

    expect(harness.reconcile).toHaveBeenCalledTimes(1)
    expect(harness.unsubscribe).toHaveBeenNthCalledWith(1, 'term-1')
    expect(harness.subscribe).toHaveBeenCalledWith('term-1')
  })

  it('subscribes the replacement handle selected by reconciliation', async () => {
    const harness = createRecoveryHarness()
    harness.reconcile.mockImplementation(async () => {
      harness.setHandle('term-2')
    })

    await expect(recoverMobileNativeChatInput(harness.args)).resolves.toBe(true)

    expect(harness.unsubscribe).toHaveBeenLastCalledWith('term-2')
    expect(harness.subscribe).toHaveBeenCalledWith('term-2')
  })

  it('stops without resubscribing if reconciliation leaves the session', async () => {
    const harness = createRecoveryHarness()
    harness.reconcile.mockImplementation(async () => {
      harness.setConnected(false)
    })

    await expect(recoverMobileNativeChatInput(harness.args)).resolves.toBe(false)

    expect(harness.subscribe).not.toHaveBeenCalled()
  })

  it('does not renew a terminal selected from another session during reconciliation', async () => {
    const harness = createRecoveryHarness()
    harness.reconcile.mockImplementation(async () => {
      harness.setSessionTabId('tab-2')
      harness.setHandle('term-2')
    })

    await expect(recoverMobileNativeChatInput(harness.args)).resolves.toBe(false)

    expect(harness.subscribe).not.toHaveBeenCalled()
  })

  it('waits for the renewed subscription acknowledgement instead of an old ready value', async () => {
    vi.useFakeTimers()
    try {
      const harness = createRecoveryHarness()
      harness.setReady(true)
      harness.unsubscribe.mockImplementation(() => harness.setReady(false))
      harness.subscribe.mockImplementation(() => undefined)

      let settled = false
      const recovery = recoverMobileNativeChatInput(harness.args).then((result) => {
        settled = true
        return result
      })
      await Promise.resolve()
      await Promise.resolve()

      expect(harness.subscribe).toHaveBeenCalled()
      expect(settled).toBe(false)
      harness.setReady(true)
      await vi.advanceTimersByTimeAsync(100)
      await expect(recovery).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
