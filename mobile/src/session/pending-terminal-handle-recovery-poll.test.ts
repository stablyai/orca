import { createElement, Suspense } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { SessionTabsApplyOutcome } from './mobile-session-tabs-stream-health'
import { PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS } from './pending-terminal-handle-recovery'
import { useMobileSessionTabsReconciliation } from './use-mobile-session-tabs-reconciliation'

type TestResult = {
  type?: 'snapshot' | 'updated'
  snapshotVersion: number
  tabs: string[]
}

type HarnessProps = {
  onParked?: (key: string | null) => void
  suspend?: Promise<never>
}

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

function result(type?: TestResult['type']): TestResult {
  return { snapshotVersion: 1, tabs: ['pending-terminal'], ...(type ? { type } : {}) }
}

function makeHarness() {
  const requestTimes: number[] = []
  const parkedContexts: (string | null)[] = []
  let contextKey: string | null = 'terminal-a'
  let otherRecoveryNeeded = false
  let connState: 'connected' | 'disconnected' = 'connected'
  let streamListener: ((payload: unknown) => void) | null = null
  let actions: ReturnType<typeof useMobileSessionTabsReconciliation<TestResult, string>> | null =
    null
  const sendRequest = vi.fn(async (): Promise<RpcSuccess> => {
    requestTimes.push(Date.now())
    return {
      id: `list-${requestTimes.length}`,
      ok: true,
      result: result(),
      _meta: { runtimeId: 'runtime-1' }
    }
  })
  const subscribe = vi.fn(
    (_method: string, _params: unknown, listener: (payload: unknown) => void) => {
      streamListener = listener
      return () => {}
    }
  )
  const client = { sendRequest, subscribe } as unknown as RpcClient
  const consumeAcceptedSessionTabs = () => {}
  const fetchTerminals = async () => {}
  const getPendingTerminalRecoveryContextKey = () => contextKey
  const hasRecoveryNeed = () => otherRecoveryNeeded
  const onPendingTerminalRecoveryParked = (key: string | null) => parkedContexts.push(key)
  const applySessionTabs = (value: TestResult): SessionTabsApplyOutcome<string> => ({
    accepted: true,
    effectiveTabs: value.tabs
  })

  function Harness({ onParked = onPendingTerminalRecoveryParked, suspend }: HarnessProps): null {
    actions = useMobileSessionTabsReconciliation<TestResult, string>({
      client,
      connState,
      worktreeId: 'repo::worktree',
      applySessionTabs,
      consumeAcceptedSessionTabs,
      fetchTerminals,
      hasRecoveryNeed,
      pendingTerminalRecoveryContextKey: contextKey,
      getPendingTerminalRecoveryContextKey,
      onPendingTerminalRecoveryParked: onParked
    })
    if (suspend) {
      throw suspend
    }
    return null
  }

  return {
    Harness,
    actions: () => actions,
    emit(payload: TestResult) {
      streamListener?.(payload)
    },
    parkedContexts,
    requestTimes,
    sendRequest,
    setConnectionState(value: typeof connState) {
      connState = value
    },
    setContextKey(value: string | null) {
      contextKey = value
    },
    setOtherRecoveryNeeded(value: boolean) {
      otherRecoveryNeeded = value
    }
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve()
  }
}

// react-test-renderer's types do not resolve in the type-aware lint project, so both
// ReactTestRenderer and ReturnType<typeof create> degrade to `any` and poison this union.
// Name the two methods this suite actually uses instead.
type MountedHarness = {
  unmount: () => void
  update: (element: ReturnType<typeof createElement>) => void
}

describe('bounded pending-handle reconciliation cadence', () => {
  let renderer: MountedHarness | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    lifecycle.appState = 'active'
    lifecycle.focused = true
    lifecycle.listeners.clear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  async function mount(harness: ReturnType<typeof makeHarness>): Promise<void> {
    await act(async () => {
      renderer = create(createElement(harness.Harness))
      await flush()
    })
    await act(async () => {
      harness.emit(result('snapshot'))
      await flush()
      harness.emit(result('updated'))
      await flush()
    })
    harness.sendRequest.mockClear()
    harness.requestTimes.length = 0
    harness.parkedContexts.length = 0
  }

  async function advance(milliseconds: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds)
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

  it('drops the main baseline from 1800 lists per hour to five, then parks', async () => {
    const harness = makeHarness()
    await mount(harness)

    await advance(3_600_000)

    expect(harness.requestTimes).toEqual([2000, 4000, 6000, 8000, 10_000])
    expect(harness.parkedContexts).toContain('terminal-a')
  })

  it('resets for active-tab and pending-terminal context changes, but not ordinary ticks', async () => {
    const harness = makeHarness()
    await mount(harness)
    await advance(12_000)
    expect(harness.requestTimes).toHaveLength(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS)

    harness.setContextKey(null)
    await advance(2000)
    const afterActiveTabChange = harness.requestTimes.length
    harness.setContextKey('terminal-a')
    await advance(2000)
    expect(harness.requestTimes).toHaveLength(afterActiveTabChange + 1)

    harness.setContextKey('terminal-b')
    await advance(2000)
    expect(harness.requestTimes).toHaveLength(afterActiveTabChange + 2)
  })

  it('resets when the active tab changes away and back between poll ticks', async () => {
    const harness = makeHarness()
    await mount(harness)
    await advance(12_000)

    harness.setContextKey(null)
    await act(async () => {
      renderer?.update(createElement(harness.Harness))
      await flush()
    })
    expect(harness.parkedContexts.at(-1)).toBeNull()
    harness.setContextKey('terminal-a')
    await act(async () => {
      renderer?.update(createElement(harness.Harness))
      await flush()
    })
    expect(harness.parkedContexts.at(-1)).toBeNull()
    await advance(2000)

    expect(harness.requestTimes).toHaveLength(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS + 1)
  })

  it('keeps the parked state across unrelated rerenders', async () => {
    const harness = makeHarness()
    await mount(harness)
    await advance(12_000)
    expect(harness.parkedContexts.at(-1)).toBe('terminal-a')

    await act(async () => {
      renderer?.update(createElement(harness.Harness))
      await flush()
    })

    expect(harness.parkedContexts.at(-1)).toBe('terminal-a')
    await advance(2000)
    expect(harness.requestTimes).toHaveLength(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS)
  })

  it('does not publish a parked callback from a suspended render', async () => {
    const harness = makeHarness()
    const committedCallback = vi.fn()
    const suspendedCallback = vi.fn()
    const neverCommits = new Promise<never>(() => {})
    await act(async () => {
      renderer = create(
        createElement(
          Suspense,
          { fallback: null },
          createElement(harness.Harness, { onParked: committedCallback })
        )
      )
      await flush()
    })
    const committedActions = harness.actions()
    committedCallback.mockClear()

    await act(async () => {
      renderer?.update(
        createElement(
          Suspense,
          { fallback: null },
          createElement(harness.Harness, {
            onParked: suspendedCallback,
            suspend: neverCommits
          })
        )
      )
      await flush()
    })
    await act(async () => {
      await committedActions?.retryPendingTerminalRecovery()
    })

    expect(committedCallback).toHaveBeenCalledWith(null)
    expect(suspendedCallback).not.toHaveBeenCalled()
  })

  it('publishes the committed parked callback before a same-commit context reset', async () => {
    const harness = makeHarness()
    const previousCallback = vi.fn()
    const committedCallback = vi.fn()
    await act(async () => {
      renderer = create(createElement(harness.Harness, { onParked: previousCallback }))
      await flush()
    })
    previousCallback.mockClear()

    harness.setContextKey('terminal-b')
    await act(async () => {
      renderer?.update(createElement(harness.Harness, { onParked: committedCallback }))
      await flush()
    })

    expect(committedCallback).toHaveBeenCalledWith(null)
    expect(previousCallback).not.toHaveBeenCalled()
  })

  it('keeps other recovery sources live while the pending-terminal budget is parked', async () => {
    const harness = makeHarness()
    await mount(harness)
    await advance(12_000)
    expect(harness.requestTimes).toEqual([2000, 4000, 6000, 8000, 10_000])

    harness.setOtherRecoveryNeeded(true)
    await advance(14_000)
    expect(harness.requestTimes).toEqual([
      2000, 4000, 6000, 8000, 10_000, 14_000, 16_000, 18_000, 20_000, 22_000, 24_000, 26_000
    ])

    harness.setOtherRecoveryNeeded(false)
    await advance(2000)
    expect(harness.requestTimes).toHaveLength(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS + 7)
  })

  it('resets after foregrounding, reconnecting, and explicit retry', async () => {
    const harness = makeHarness()
    await mount(harness)
    await advance(12_000)

    await setAppState('background')
    await setAppState('active')
    expect(harness.requestTimes).toHaveLength(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS + 1)
    await advance(2000)
    expect(harness.requestTimes).toHaveLength(PENDING_TERMINAL_HANDLE_RECOVERY_ATTEMPTS + 2)
    await advance(10_000)

    harness.setConnectionState('disconnected')
    await act(async () => {
      renderer?.update(createElement(harness.Harness))
      await flush()
    })
    harness.setConnectionState('connected')
    await act(async () => {
      renderer?.update(createElement(harness.Harness))
      await flush()
    })
    await act(async () => {
      harness.emit(result('updated'))
      await flush()
    })
    const afterReconnect = harness.requestTimes.length
    await advance(2000)
    expect(harness.requestTimes).toHaveLength(afterReconnect + 1)

    await advance(10_000)
    const beforeRetry = harness.requestTimes.length
    await act(async () => {
      await harness.actions()?.retryPendingTerminalRecovery()
    })
    expect(harness.requestTimes).toHaveLength(beforeRetry + 1)
    await advance(2000)
    expect(harness.requestTimes).toHaveLength(beforeRetry + 2)
  })
})
