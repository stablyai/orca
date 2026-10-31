import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { SessionTabsApplyOutcome } from './mobile-session-tabs-stream-health'
import { useMobileSessionTabsReconciliation } from './use-mobile-session-tabs-reconciliation'
import type { MobileTerminalInventoryRefreshOptions } from './use-mobile-terminal-inventory-recovery'

const lifecycle = vi.hoisted(() => ({
  appState: 'active',
  focused: true,
  listeners: new Set<(state: string) => void>()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return lifecycle.appState
    },
    addEventListener(_event: string, listener: (state: string) => void) {
      lifecycle.listeners.add(listener)
      return { remove: () => lifecycle.listeners.delete(listener) }
    }
  }
}))

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(() => (lifecycle.focused ? effect() : undefined), [effect, lifecycle.focused])
    }
  }
})

type TestResult = {
  type?: 'snapshot' | 'updated' | 'error' | 'end'
  snapshotVersion: number
  tabs: string[]
}

const fetchTerminals = vi.fn(async (options?: MobileTerminalInventoryRefreshOptions) => {
  options?.onPhysicalRequestStarted?.(Date.now())
  return true
})
const applySessionTabs = vi.fn((value: TestResult): SessionTabsApplyOutcome<string> => ({
  accepted: true,
  effectiveTabs: value.tabs
}))
const consumeAcceptedSessionTabs = vi.fn()
let recoveryNeeded = false
let clearRecoveryAt = Number.POSITIVE_INFINITY
const hasRecoveryNeed = () => recoveryNeeded
const subscribe = vi.fn()
const unsubscribe = vi.fn()
let streamListener: ((payload: unknown) => void) | null = null
let requestTerminalInventoryRecovery: (() => void) | null = null
let connectionState: ConnectionState = 'connected'
let clientConnectionState: ConnectionState = 'connected'
let listSequence = 0
const sendRequest = vi.fn(async () => ({
  id: `list-${++listSequence}`,
  ok: true as const,
  result: {
    snapshotVersion: listSequence,
    tabs: [`tab-${listSequence}`]
  },
  _meta: { runtimeId: 'runtime-1' }
}))
const client = {
  sendRequest,
  subscribe,
  getState: () => clientConnectionState
} as unknown as RpcClient
const replacementClient = {
  sendRequest,
  subscribe,
  getState: () => clientConnectionState
} as unknown as RpcClient
let currentClient: RpcClient = client
let currentWorktreeId = 'repo::worktree'
let currentTerminalInventoryRecoveryScopeKey = 'host::repo::worktree'

function applyWithRecovery(value: TestResult): SessionTabsApplyOutcome<string> {
  const outcome = applySessionTabs(value)
  if (outcome.accepted && Date.now() >= clearRecoveryAt) {
    recoveryNeeded = false
  }
  return outcome
}

function Harness(): null {
  const actions = useMobileSessionTabsReconciliation<TestResult, string>({
    client: currentClient,
    connState: connectionState,
    worktreeId: currentWorktreeId,
    applySessionTabs: applyWithRecovery,
    consumeAcceptedSessionTabs,
    fetchTerminals,
    terminalInventoryRecoveryScopeKey: currentTerminalInventoryRecoveryScopeKey,
    hasRecoveryNeed
  })
  useEffect(() => {
    requestTerminalInventoryRecovery = actions.requestTerminalInventoryRecovery
    return () => {
      if (requestTerminalInventoryRecovery === actions.requestTerminalInventoryRecovery) {
        requestTerminalInventoryRecovery = null
      }
    }
  }, [actions.requestTerminalInventoryRecovery])
  return null
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function emitStream(payload: TestResult): Promise<void> {
  await act(async () => {
    streamListener?.(payload)
    await flush()
  })
}

async function setAppState(state: string): Promise<void> {
  lifecycle.appState = state
  await act(async () => {
    for (const listener of lifecycle.listeners) {
      listener(state)
    }
    await flush()
  })
}

function expectedRecoveryInventoryOptions() {
  return expect.objectContaining({
    allowEmptyLoaded: true,
    onPhysicalRequestStarted: expect.any(Function)
  })
}

describe('useMobileSessionTabsReconciliation', () => {
  let renderer: ReactTestRenderer | null = null
  async function mount(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness))
      await flush()
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    lifecycle.appState = 'active'
    lifecycle.focused = true
    lifecycle.listeners.clear()
    connectionState = 'connected'
    clientConnectionState = 'connected'
    currentClient = client
    currentWorktreeId = 'repo::worktree'
    currentTerminalInventoryRecoveryScopeKey = 'host::repo::worktree'
    recoveryNeeded = false
    clearRecoveryAt = Number.POSITIVE_INFINITY
    listSequence = 0
    fetchTerminals.mockReset()
    fetchTerminals.mockImplementation(async (options?: MobileTerminalInventoryRefreshOptions) => {
      options?.onPhysicalRequestStarted?.(Date.now())
      return true
    })
    applySessionTabs.mockClear()
    consumeAcceptedSessionTabs.mockClear()
    unsubscribe.mockClear()
    sendRequest.mockClear()
    subscribe
      .mockReset()
      .mockImplementation(
        (_method: string, _params: unknown, listener: (payload: unknown) => void) => {
          streamListener = listener
          return unsubscribe
        }
      )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    streamListener = null
    requestTerminalInventoryRecovery = null
    vi.useRealTimers()
  })

  it('runs one terminal health sweep and zero tab lists in a certified warm minute', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    sendRequest.mockClear()
    fetchTerminals.mockClear()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(sendRequest).not.toHaveBeenCalled()
    expect(fetchTerminals).toHaveBeenCalledTimes(1)
  })

  it('backs off a failed certified terminal sweep for another minute', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    fetchTerminals.mockClear()
    fetchTerminals.mockResolvedValue(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(58_000)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(2)
  })

  it('coalesces terminal teardown into two separated inventory passes', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    fetchTerminals.mockClear()

    await act(async () => {
      requestTerminalInventoryRecovery?.()
      requestTerminalInventoryRecovery?.()
      requestTerminalInventoryRecovery?.()
      await flush()
    })

    expect(fetchTerminals).toHaveBeenCalledExactlyOnceWith(expectedRecoveryInventoryOptions())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(749)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(2)
    expect(fetchTerminals).toHaveBeenLastCalledWith(expectedRecoveryInventoryOptions())
  })

  it('moves the certified sweep deadline after teardown recovery', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    fetchTerminals.mockClear()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
      requestTerminalInventoryRecovery?.()
      await flush()
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(fetchTerminals).toHaveBeenCalledTimes(2)
    expect(fetchTerminals).toHaveBeenNthCalledWith(1, expectedRecoveryInventoryOptions())
    expect(fetchTerminals).toHaveBeenNthCalledWith(2, expectedRecoveryInventoryOptions())
  })

  it.each(['failure', 'rejection'] as const)(
    'does not confirm terminal absence after an unverifiable first-pass %s',
    async (outcome) => {
      await mount()
      await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
      fetchTerminals.mockClear()
      if (outcome === 'failure') {
        fetchTerminals.mockResolvedValueOnce(false)
      } else {
        fetchTerminals.mockRejectedValueOnce(new Error('transport lost'))
      }

      await act(async () => {
        requestTerminalInventoryRecovery?.()
        await flush()
        await vi.advanceTimersByTimeAsync(750)
      })

      expect(fetchTerminals).toHaveBeenCalledExactlyOnceWith(expectedRecoveryInventoryOptions())
    }
  )

  it.each(['background', 'blur', 'disconnect', 'socket-loss', 'unmount'] as const)(
    'cancels terminal inventory confirmation on %s',
    async (lifecycleChange) => {
      await mount()
      await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
      fetchTerminals.mockClear()
      await act(async () => {
        requestTerminalInventoryRecovery?.()
        await flush()
      })
      expect(fetchTerminals).toHaveBeenCalledTimes(1)

      if (lifecycleChange === 'background') {
        await setAppState('background')
      } else if (lifecycleChange === 'blur') {
        lifecycle.focused = false
        await act(async () => {
          renderer?.update(createElement(Harness))
          await flush()
        })
      } else if (lifecycleChange === 'disconnect') {
        connectionState = 'disconnected'
        await act(async () => {
          renderer?.update(createElement(Harness))
          await flush()
        })
      } else if (lifecycleChange === 'socket-loss') {
        clientConnectionState = 'disconnected'
      } else {
        await act(async () => {
          renderer?.unmount()
          await flush()
        })
        renderer = null
      }

      await act(async () => {
        await vi.advanceTimersByTimeAsync(750)
      })
      expect(fetchTerminals).toHaveBeenCalledTimes(1)
    }
  )

  it('resumes a pending terminal confirmation after returning to the foreground', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    fetchTerminals.mockClear()
    await act(async () => {
      requestTerminalInventoryRecovery?.()
      await flush()
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    await setAppState('background')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    await setAppState('active')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })

    expect(fetchTerminals).toHaveBeenCalledTimes(4)
    expect(fetchTerminals).toHaveBeenNthCalledWith(3, expectedRecoveryInventoryOptions())
    expect(fetchTerminals).toHaveBeenNthCalledWith(4, expectedRecoveryInventoryOptions())
  })

  it('resumes pending terminal recovery after a silent socket reconnect', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    fetchTerminals.mockClear()
    await act(async () => {
      requestTerminalInventoryRecovery?.()
      await flush()
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    clientConnectionState = 'disconnected'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    clientConnectionState = 'connected'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_250)
      await vi.advanceTimersByTimeAsync(750)
    })

    expect(fetchTerminals).toHaveBeenCalledTimes(3)
    expect(fetchTerminals).toHaveBeenNthCalledWith(2, expectedRecoveryInventoryOptions())
    expect(fetchTerminals).toHaveBeenNthCalledWith(3, expectedRecoveryInventoryOptions())
  })

  it('resumes a pending terminal confirmation after controller replacement', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    fetchTerminals.mockClear()
    await act(async () => {
      requestTerminalInventoryRecovery?.()
      await flush()
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    currentClient = replacementClient
    await act(async () => {
      renderer?.update(createElement(Harness))
      await flush()
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(4)
    expect(fetchTerminals).toHaveBeenLastCalledWith(expectedRecoveryInventoryOptions())
  })

  it('drops pending terminal confirmation when the route identity changes', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    fetchTerminals.mockClear()
    await act(async () => {
      requestTerminalInventoryRecovery?.()
      await flush()
    })
    expect(fetchTerminals).toHaveBeenCalledTimes(1)

    currentWorktreeId = 'repo::other-worktree'
    currentTerminalInventoryRecoveryScopeKey = 'host::repo::other-worktree'
    await act(async () => {
      renderer?.update(createElement(Harness))
      await flush()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })

    expect(fetchTerminals).toHaveBeenCalledTimes(2)
    expect(fetchTerminals).toHaveBeenLastCalledWith(
      expect.objectContaining({ onPhysicalRequestStarted: expect.any(Function) })
    )
  })

  it('starts replacement-tab polling after confirmed terminal inventory absence', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    sendRequest.mockClear()
    fetchTerminals.mockClear()
    clearRecoveryAt = 4_000
    let successfulEmptyInventories = 0
    let terminalPruned = false
    fetchTerminals.mockImplementation(async () => {
      successfulEmptyInventories += 1
      if (successfulEmptyInventories === 2) {
        terminalPruned = true
        recoveryNeeded = true
      }
      return true
    })

    await act(async () => {
      requestTerminalInventoryRecovery?.()
      await flush()
    })
    expect(terminalPruned).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })
    expect(successfulEmptyInventories).toBe(2)
    expect(terminalPruned).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_250)
    })

    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(recoveryNeeded).toBe(false)
  })

  it('runs an immediate list plus five fallback lists over ten probing seconds', async () => {
    await mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(sendRequest).toHaveBeenCalledTimes(6)
    expect(fetchTerminals).toHaveBeenCalledTimes(6)
  })

  it('runs an immediate list plus five fallback lists after stream degradation', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    sendRequest.mockClear()
    fetchTerminals.mockClear()
    await emitStream({ type: 'error', snapshotVersion: 1, tabs: [] })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(sendRequest).toHaveBeenCalledTimes(6)
    expect(fetchTerminals).toHaveBeenCalledTimes(5)
  })

  it('does no reconciliation work while backgrounded or blurred', async () => {
    lifecycle.appState = 'background'
    await mount()
    await emitStream({ type: 'snapshot', snapshotVersion: 1, tabs: ['tab-1'] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(sendRequest).not.toHaveBeenCalled()
    expect(fetchTerminals).not.toHaveBeenCalled()

    lifecycle.appState = 'active'
    lifecycle.focused = false
    await act(async () => {
      renderer?.update(createElement(Harness))
      await flush()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(sendRequest).not.toHaveBeenCalled()
    expect(fetchTerminals).not.toHaveBeenCalled()
  })

  it('reconciles immediately on resume even while the stream is certified', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    await setAppState('background')
    sendRequest.mockClear()
    fetchTerminals.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    await setAppState('active')

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(fetchTerminals).toHaveBeenCalledTimes(1)
  })

  it('reconciles immediately when a certified route regains focus', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    lifecycle.focused = false
    await act(async () => {
      renderer?.update(createElement(Harness))
      await flush()
    })
    sendRequest.mockClear()
    fetchTerminals.mockClear()

    lifecycle.focused = true
    await act(async () => {
      renderer?.update(createElement(Harness))
      await flush()
    })

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(fetchTerminals).toHaveBeenCalledTimes(1)
  })

  it('polls five times through a ten-second close tombstone and then stops', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    sendRequest.mockClear()
    fetchTerminals.mockClear()
    recoveryNeeded = true
    clearRecoveryAt = 10_000

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(sendRequest).toHaveBeenCalledTimes(5)
    expect(fetchTerminals).toHaveBeenCalledTimes(5)
    expect(recoveryNeeded).toBe(false)
  })

  it('keeps the controller and physical subscription stable across route rerenders', async () => {
    await mount()
    const initialListener = streamListener

    await act(async () => {
      renderer?.update(createElement(Harness))
      await flush()
    })

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(streamListener).toBe(initialListener)
  })
})
