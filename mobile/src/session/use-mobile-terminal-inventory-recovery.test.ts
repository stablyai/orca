import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileTerminalInventoryRecovery,
  useMobileTerminalInventoryRecoveryBridge
} from './use-mobile-terminal-inventory-recovery'

const lifecycle = vi.hoisted(() => ({ appState: 'active' }))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return lifecycle.appState
    }
  }
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const client = {
  getState: () => 'connected'
} as unknown as RpcClient
const fetchTerminals = vi.fn(async () => true)
type RecoveryActions = ReturnType<typeof useMobileTerminalInventoryRecovery>
let actions: RecoveryActions | null = null

function Harness({ scopeKey }: { scopeKey: string }): null {
  const recovery = useMobileTerminalInventoryRecovery({
    client,
    connState: 'connected',
    fetchTerminals,
    scopeKey
  })
  useEffect(() => {
    actions = recovery
    return () => {
      if (actions === recovery) {
        actions = null
      }
    }
  }, [recovery])
  return null
}

function BridgeHarness({
  scopeKey,
  connect,
  request
}: {
  scopeKey: string
  connect: boolean
  request: () => void
}): null {
  const bridge = useMobileTerminalInventoryRecoveryBridge(scopeKey)
  useEffect(() => {
    bridgeSignal = bridge.signalTerminalInventoryRecovery
    if (!connect) {
      return () => {
        if (bridgeSignal === bridge.signalTerminalInventoryRecovery) {
          bridgeSignal = null
        }
      }
    }
    return bridge.registerTerminalInventoryRecoveryAction(request)
  }, [bridge, connect, request])
  return null
}

let bridgeSignal: (() => void) | null = null

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useMobileTerminalInventoryRecovery', () => {
  let renderer: ReactTestRenderer | null = null
  let bridgeRenderer: ReactTestRenderer | null = null

  async function mount(scopeKey = 'host::worktree-a'): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { scopeKey }))
      await flush()
    })
    act(() => actions?.activateTerminalInventoryRecovery())
  }

  beforeEach(() => {
    vi.useFakeTimers()
    lifecycle.appState = 'active'
    fetchTerminals.mockReset()
    fetchTerminals.mockResolvedValue(true)
    bridgeSignal = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    act(() => bridgeRenderer?.unmount())
    renderer = null
    bridgeRenderer = null
    actions = null
    bridgeSignal = null
    vi.useRealTimers()
  })

  it('queues a bridge signal until the recovery action connects', async () => {
    const request = vi.fn()
    await act(async () => {
      bridgeRenderer = create(
        createElement(BridgeHarness, { scopeKey: 'scope-a', connect: false, request })
      )
      await flush()
    })

    const preConnectSignal = bridgeSignal
    expect(preConnectSignal).toEqual(expect.any(Function))
    act(() => preConnectSignal?.())
    expect(request).not.toHaveBeenCalled()

    await act(async () => {
      bridgeRenderer?.update(
        createElement(BridgeHarness, { scopeKey: 'scope-a', connect: true, request })
      )
      await flush()
    })
    expect(request).toHaveBeenCalledExactlyOnceWith()
  })

  it('ignores a stale bridge signal after the committed scope changes', async () => {
    const requestA = vi.fn()
    const requestB = vi.fn()
    await act(async () => {
      bridgeRenderer = create(
        createElement(BridgeHarness, { scopeKey: 'scope-a', connect: true, request: requestA })
      )
      await flush()
    })
    const staleSignal = bridgeSignal

    await act(async () => {
      bridgeRenderer?.update(
        createElement(BridgeHarness, { scopeKey: 'scope-b', connect: true, request: requestB })
      )
      await flush()
    })
    act(() => staleSignal?.())
    expect(requestA).not.toHaveBeenCalled()
    expect(requestB).not.toHaveBeenCalled()

    act(() => bridgeSignal?.())
    expect(requestB).toHaveBeenCalledExactlyOnceWith()
  })

  it('coalesces signals before confirmation into the scheduled pass', async () => {
    const firstPass = deferred<boolean>()
    const confirmation = deferred<boolean>()
    fetchTerminals
      .mockImplementationOnce(() => firstPass.promise)
      .mockImplementationOnce(() => confirmation.promise)
    await mount()

    act(() => {
      actions?.requestTerminalInventoryRecovery()
      actions?.requestTerminalInventoryRecovery()
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstPass.resolve(true)
      await flush()
      actions?.requestTerminalInventoryRecovery()
      await vi.advanceTimersByTimeAsync(750)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(2)

    await act(async () => {
      confirmation.resolve(true)
      await flush()
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(2)
  })

  it.each(['failure', 'rejection'] as const)(
    'retries one queued signal after a first-pass %s',
    async (outcome) => {
      const firstPass = deferred<boolean>()
      fetchTerminals.mockImplementationOnce(() => firstPass.promise).mockResolvedValueOnce(false)
      await mount()

      act(() => {
        actions?.requestTerminalInventoryRecovery()
        actions?.requestTerminalInventoryRecovery()
      })
      await act(async () => {
        if (outcome === 'failure') {
          firstPass.resolve(false)
        } else {
          firstPass.reject(new Error('transport lost'))
        }
        await flush()
      })

      expect(fetchTerminals).toHaveBeenCalledTimes(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(fetchTerminals).toHaveBeenCalledTimes(2)
    }
  )

  it('runs one follow-up cycle for signals received during confirmation', async () => {
    const confirmation = deferred<boolean>()
    fetchTerminals
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => confirmation.promise)
      .mockResolvedValueOnce(false)
    await mount()

    act(() => actions?.requestTerminalInventoryRecovery())
    await act(async () => {
      await flush()
      await vi.advanceTimersByTimeAsync(750)
      actions?.requestTerminalInventoryRecovery()
      actions?.requestTerminalInventoryRecovery()
      confirmation.resolve(false)
      await flush()
    })

    expect(fetchTerminals).toHaveBeenCalledTimes(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(3)
  })

  it('retains one cycle across lifecycle suspension and fences the old pass', async () => {
    const oldPass = deferred<boolean>()
    fetchTerminals.mockImplementationOnce(() => oldPass.promise).mockResolvedValueOnce(false)
    await mount()

    act(() => {
      actions?.requestTerminalInventoryRecovery()
      actions?.suspendTerminalInventoryRecovery(true)
    })
    await act(async () => {
      oldPass.resolve(false)
      await flush()
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    act(() => {
      actions?.activateTerminalInventoryRecovery()
      actions?.resumePendingTerminalInventoryRecovery()
    })
    await act(flush)
    expect(fetchTerminals).toHaveBeenCalledTimes(2)
  })

  it('drops queued work when the recovery scope changes', async () => {
    const oldPass = deferred<boolean>()
    fetchTerminals.mockImplementationOnce(() => oldPass.promise)
    await mount()

    act(() => {
      actions?.requestTerminalInventoryRecovery()
      actions?.requestTerminalInventoryRecovery()
    })
    await act(async () => {
      renderer?.update(createElement(Harness, { scopeKey: 'host::worktree-b' }))
    })
    await act(async () => {
      oldPass.resolve(false)
      await flush()
    })
    act(() => {
      actions?.activateTerminalInventoryRecovery()
      actions?.resumePendingTerminalInventoryRecovery()
    })

    expect(fetchTerminals).toHaveBeenCalledTimes(1)
  })

  it('does not let an old inventory completion move the new scope deadline', async () => {
    const oldPass = deferred<boolean>()
    let reportPhysicalStart: ((startedAt: number) => void) | undefined
    fetchTerminals.mockImplementationOnce(async (options) => {
      reportPhysicalStart = options?.onPhysicalRequestStarted
      return oldPass.promise
    })
    await mount('scope-a')
    vi.setSystemTime(100)
    const oldRefresh = actions?.refreshTerminalInventory
    expect(oldRefresh).toEqual(expect.any(Function))
    const oldRequest = oldRefresh!()
    await flush()
    reportPhysicalStart?.(100)
    expect(actions?.isCertifiedTerminalSweepDue(100)).toBe(false)

    await act(async () => {
      renderer?.update(createElement(Harness, { scopeKey: 'scope-b' }))
      await flush()
    })
    expect(actions?.isCertifiedTerminalSweepDue(100)).toBe(true)

    reportPhysicalStart?.(100)
    oldPass.resolve(true)
    await oldRequest
    await flush()
    expect(actions?.isCertifiedTerminalSweepDue(100)).toBe(true)
  })
})
