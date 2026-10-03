import { describe, expect, it, vi } from 'vitest'
import {
  releaseSocketTimer,
  rememberSocketDeadlineClock,
  startSocketDeadlineClock,
  takeSocketDeadline
} from './socket-deadline-clock'
import { describeSocketDeadline } from './socket-deadline-suspension'

const listeners = vi.hoisted(() => new Set<(state: string) => void>())

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener)
      return {
        remove: () => {
          listeners.delete(listener)
        }
      }
    }
  }
}))

describe('startSocketDeadlineClock', () => {
  it('reports a wall-clock jump while the app stays active as a host timeout', () => {
    listeners.clear()
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
    expect(listeners.size).toBe(0)
  })

  it('reports suspension when the app leaves the foreground during the dial', () => {
    listeners.clear()
    let wallMs = 50_000
    let monotonicMs = 10
    const clock = startSocketDeadlineClock(
      () => wallMs,
      () => monotonicMs
    )
    for (const listener of listeners) {
      listener('background')
    }
    wallMs -= 5_000
    monotonicMs += 12_000
    const report = describeSocketDeadline({
      kind: 'connect',
      timeoutMs: 12_000,
      ...clock.finish()
    })

    expect(report.code).toBe('suspended-dial')
    expect(report.detail).not.toContain('endpoint unreachable')
  })

  it('drops the foreground watch when the timer is cleared', () => {
    listeners.clear()
    const timer = setTimeout(() => undefined, 60_000)
    rememberSocketDeadlineClock(timer, startSocketDeadlineClock())
    expect(listeners.size).toBe(1)

    expect(releaseSocketTimer(timer)).toBeNull()
    expect(listeners.size).toBe(0)
    expect(takeSocketDeadline(timer).leftForeground).toBe(false)
  })
})
