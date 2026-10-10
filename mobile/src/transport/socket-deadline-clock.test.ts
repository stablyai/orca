import { describe, expect, it, vi } from 'vitest'
import {
  releaseSocketTimer,
  rememberSocketDeadlineClock,
  startSocketDeadlineClock,
  takeSocketDeadline
} from './socket-deadline-clock'
import { describeSocketDeadline } from './socket-deadline-suspension'

const appState = vi.hoisted(() => ({
  currentState: 'active',
  listeners: new Set<(state: string) => void>()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listeners.add(listener)
      return {
        remove: () => {
          appState.listeners.delete(listener)
        }
      }
    }
  }
}))

describe('startSocketDeadlineClock', () => {
  it('reports a wall-clock jump while the app stays active as a host timeout', () => {
    appState.currentState = 'active'
    appState.listeners.clear()
    let wallMs = 1_000
    let monotonicMs = 50
    const clock = startSocketDeadlineClock(
      () => wallMs,
      () => monotonicMs
    )
    wallMs += 3 * 60 * 60 * 1000
    monotonicMs += 12_000
    const report = describeSocketDeadline({
      kind: 'connect',
      timeoutMs: 12_000,
      ...clock.finish()
    })

    expect(report.code).toBe('connect-timeout')
    expect(appState.listeners.size).toBe(0)
  })

  it('keeps a host timeout when a short foreground loss does not delay the clocks', () => {
    appState.currentState = 'active'
    appState.listeners.clear()
    let wallMs = 50_000
    let monotonicMs = 10
    const clock = startSocketDeadlineClock(
      () => wallMs,
      () => monotonicMs
    )
    for (const listener of appState.listeners) {
      listener('background')
    }
    wallMs -= 5_000
    monotonicMs += 12_000
    const report = describeSocketDeadline({
      kind: 'connect',
      timeoutMs: 12_000,
      ...clock.finish()
    })

    expect(report.code).toBe('connect-timeout')
    expect(report.detail).toContain('endpoint unreachable')
  })

  it('keeps an on-budget timeout when a transient inactive state has ended', () => {
    appState.currentState = 'active'
    appState.listeners.clear()
    let wallMs = 1_000
    let monotonicMs = 50
    const clock = startSocketDeadlineClock(
      () => wallMs,
      () => monotonicMs
    )
    for (const listener of appState.listeners) {
      listener('inactive')
      listener('active')
    }
    wallMs += 12_000
    monotonicMs += 12_000

    const report = describeSocketDeadline({
      kind: 'connect',
      timeoutMs: 12_000,
      ...clock.finish()
    })

    expect(report.code).toBe('connect-timeout')
  })

  it('detects suspension when the watcher starts after the app is already backgrounded', () => {
    appState.currentState = 'background'
    appState.listeners.clear()
    let wallMs = 1_000
    let monotonicMs = 50
    const clock = startSocketDeadlineClock(
      () => wallMs,
      () => monotonicMs
    )
    wallMs += 3 * 60 * 60 * 1000
    monotonicMs += 12_000

    const report = describeSocketDeadline({
      kind: 'handshake',
      timeoutMs: 5_000,
      ...clock.finish()
    })

    expect(report.code).toBe('suspended-dial')
    expect(appState.listeners.size).toBe(0)
  })

  it('drops the foreground watch when the timer is cleared', () => {
    appState.currentState = 'active'
    appState.listeners.clear()
    const timer = setTimeout(() => undefined, 60_000)
    rememberSocketDeadlineClock(timer, startSocketDeadlineClock())
    expect(appState.listeners.size).toBe(1)

    expect(releaseSocketTimer(timer)).toBeNull()
    expect(appState.listeners.size).toBe(0)
    expect(takeSocketDeadline(timer).leftForeground).toBe(false)
  })
})
