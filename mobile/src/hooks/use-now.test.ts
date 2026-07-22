import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const appState = vi.hoisted(() => ({
  current: 'active',
  listener: null as ((nextState: string) => void) | null,
  remove: vi.fn()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState(): string {
      return appState.current
    },
    addEventListener: (_event: string, listener: (nextState: string) => void) => {
      appState.listener = listener
      return { remove: appState.remove }
    }
  }
}))

import { useNow } from './use-now'

describe('useNow', () => {
  let renderer: ReactTestRenderer | null = null
  let latest = 0
  let consoleSpy: MockInstance

  function Harness({ enabled = true }: { enabled?: boolean }): null {
    latest = useNow(1_000, enabled)
    return null
  }

  function changeAppState(nextState: string): void {
    act(() => {
      appState.current = nextState
      appState.listener?.(nextState)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    appState.current = 'active'
    appState.listener = null
    appState.remove.mockClear()
    latest = 0
    const original = console.error
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    act(() => {
      renderer = create(createElement(Harness))
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
    consoleSpy.mockRestore()
  })

  it('ticks while active, pauses in the background, and refreshes immediately on resume', () => {
    expect(latest).toBe(1_000)

    act(() => vi.advanceTimersByTime(1_000))
    expect(latest).toBe(2_000)

    changeAppState('background')
    act(() => vi.advanceTimersByTime(5_000))
    expect(latest).toBe(2_000)

    changeAppState('active')
    expect(latest).toBe(7_000)

    act(() => vi.advanceTimersByTime(1_000))
    expect(latest).toBe(8_000)
  })

  it('stops while disabled and refreshes immediately when re-enabled', () => {
    act(() => renderer?.update(createElement(Harness, { enabled: false })))
    act(() => vi.advanceTimersByTime(5_000))
    expect(latest).toBe(1_000)

    act(() => renderer?.update(createElement(Harness, { enabled: true })))
    expect(latest).toBe(6_000)
  })

  it('removes the shared AppState listener after the last caller unmounts', () => {
    act(() => renderer?.unmount())
    renderer = null

    expect(appState.remove).toHaveBeenCalledTimes(1)
  })
})
