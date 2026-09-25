import { afterEach, describe, expect, it, vi } from 'vitest'
import { SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS } from '../ipc/pty/delivery/visibility-state'
import { TerminalIntentionalStops } from './terminal-intentional-stops'

afterEach(() => {
  vi.useRealTimers()
})

describe('terminal intentional stops', () => {
  it('keeps the mark while a second overlapping owner still holds it', () => {
    const stops = new TerminalIntentionalStops()
    const settleFirst = stops.mark('pty-1', 'reversible', 'inc-1')
    const settleSecond = stops.mark('pty-1', 'reversible', 'inc-1')

    settleFirst(false)

    expect(stops.isReversibleStopInFlight('pty-1')).toBe(true)
    expect(stops.claimExit('pty-1', 'inc-1')).toBe('reversible')
    settleSecond(false)
    expect(stops.claimExit('pty-1', 'inc-1')).toBeNull()
  })

  it('still reads an exit that lands after the stop settled, until the window closes', () => {
    vi.useFakeTimers()
    const stops = new TerminalIntentionalStops()
    const settle = stops.mark('pty-ssh', 'reversible', 'inc-1')

    settle(true)
    vi.advanceTimersByTime(SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS - 1)

    expect(stops.isReversibleStopInFlight('pty-ssh')).toBe(false)
    expect(stops.claimExit('pty-ssh', 'inc-1')).toBe('reversible')
    vi.advanceTimersByTime(1)
    expect(stops.claimExit('pty-ssh', 'inc-1')).toBeNull()
  })

  it('drops the mark at once when the stop fails', () => {
    const stops = new TerminalIntentionalStops()

    stops.mark('pty-1', 'replaced', 'inc-1')(false)

    expect(stops.claimExit('pty-1', 'inc-1')).toBeNull()
  })

  it('reads the synthetic exit and the provider exit of the same process alike', () => {
    const stops = new TerminalIntentionalStops()
    const settle = stops.mark('pty-1', 'replaced', null)

    expect(stops.claimExit('pty-1', 'inc-1')).toBe('replaced')
    settle(true)

    expect(stops.claimExit('pty-1', 'inc-1')).toBe('replaced')
    expect(stops.claimExit('pty-1', 'inc-2')).toBeNull()
  })

  it('never marks the exit of another process that reuses the id', () => {
    const stops = new TerminalIntentionalStops()
    stops.mark('pty-1', 'reversible', 'inc-1')

    expect(stops.claimExit('pty-1', 'inc-2')).toBeNull()
  })

  it('starts a new stop of the same id fresh once the prior one settled', () => {
    const stops = new TerminalIntentionalStops()
    stops.mark('pty-1', 'reversible', 'inc-1')(true)

    const settle = stops.mark('pty-1', 'replaced', 'inc-2')

    expect(stops.claimExit('pty-1', 'inc-1')).toBeNull()
    expect(stops.claimExit('pty-1', 'inc-2')).toBe('replaced')
    settle(false)
    expect(stops.claimExit('pty-1', 'inc-2')).toBeNull()
  })
})
