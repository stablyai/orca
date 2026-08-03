import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { SessionTabsApplyOutcome } from './mobile-session-tabs-stream-health'
import { useMobileSessionTabsReconciliation } from './use-mobile-session-tabs-reconciliation'

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

const fetchTerminals = vi.fn(async () => {})
const applySessionTabs = vi.fn(
  (value: TestResult): SessionTabsApplyOutcome<string> => ({
    accepted: true,
    effectiveTabs: value.tabs
  })
)
const consumeAcceptedSessionTabs = vi.fn()
let recoveryNeeded = false
let clearRecoveryAt = Number.POSITIVE_INFINITY
const hasRecoveryNeed = () => recoveryNeeded
const subscribe = vi.fn()
const unsubscribe = vi.fn()
let streamListener: ((payload: unknown) => void) | null = null
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
  subscribe
} as unknown as RpcClient

function applyWithRecovery(value: TestResult): SessionTabsApplyOutcome<string> {
  const outcome = applySessionTabs(value)
  if (outcome.accepted && Date.now() >= clearRecoveryAt) {
    recoveryNeeded = false
  }
  return outcome
}

function Harness(): null {
  useMobileSessionTabsReconciliation<TestResult, string>({
    client,
    connState: 'connected',
    worktreeId: 'repo::worktree',
    applySessionTabs: applyWithRecovery,
    consumeAcceptedSessionTabs,
    fetchTerminals,
    hasRecoveryNeed
  })
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

describe('useMobileSessionTabsReconciliation', () => {
  let renderer: ReactTestRenderer | null = null
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  async function mount(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness))
      await flush()
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalConsoleError = console.error
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      originalConsoleError(...args)
    })
    lifecycle.appState = 'active'
    lifecycle.focused = true
    lifecycle.listeners.clear()
    recoveryNeeded = false
    clearRecoveryAt = Number.POSITIVE_INFINITY
    listSequence = 0
    fetchTerminals.mockClear()
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
    consoleErrorSpy.mockRestore()
    vi.useRealTimers()
  })

  it('does zero tab lists and thirty terminal lists in a certified warm minute', async () => {
    await mount()
    await emitStream({ type: 'updated', snapshotVersion: 1, tabs: ['tab-1'] })
    sendRequest.mockClear()
    fetchTerminals.mockClear()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(sendRequest).not.toHaveBeenCalled()
    expect(fetchTerminals).toHaveBeenCalledTimes(30)
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
    expect(fetchTerminals).toHaveBeenCalledTimes(6)
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
