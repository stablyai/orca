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
    expect(stops.claimExit('pty-1', 'inc-1')).toEqual(['reversible'])
    settleSecond(false)
    expect(stops.claimExit('pty-1', 'inc-1')).toEqual([])
  })

  it('still reads an exit that lands after the stop settled, until the window closes', () => {
    vi.useFakeTimers()
    const stops = new TerminalIntentionalStops()
    const settle = stops.mark('pty-ssh', 'reversible', 'inc-1')

    settle(true)
    vi.advanceTimersByTime(SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS - 1)

    expect(stops.isReversibleStopInFlight('pty-ssh')).toBe(false)
    expect(stops.claimExit('pty-ssh', 'inc-1')).toEqual(['reversible'])
    vi.advanceTimersByTime(1)
    expect(stops.claimExit('pty-ssh', 'inc-1')).toEqual([])
  })

  it('drops the mark at once when the stop fails', () => {
    const stops = new TerminalIntentionalStops()

    stops.mark('pty-1', 'replaced', 'inc-1')(false)

    expect(stops.claimExit('pty-1', 'inc-1')).toEqual([])
  })

  it('reads the synthetic exit and the provider exit of the same process alike', () => {
    const stops = new TerminalIntentionalStops()
    const settle = stops.mark('pty-1', 'replaced', null)

    expect(stops.claimExit('pty-1', 'inc-1')).toEqual(['replaced'])
    settle(true)

    expect(stops.claimExit('pty-1', 'inc-1')).toEqual(['replaced'])
    expect(stops.claimExit('pty-1', 'inc-2')).toEqual([])
  })

  it('never marks the exit of another process that reuses the id', () => {
    const stops = new TerminalIntentionalStops()
    stops.mark('pty-1', 'reversible', 'inc-1')

    expect(stops.claimExit('pty-1', 'inc-2')).toEqual([])
  })

  it('starts a new stop of the same id fresh once the prior one settled', () => {
    const stops = new TerminalIntentionalStops()
    stops.mark('pty-1', 'reversible', 'inc-1')(true)

    const settle = stops.mark('pty-1', 'replaced', 'inc-2')

    expect(stops.claimExit('pty-1', 'inc-1')).toEqual([])
    expect(stops.claimExit('pty-1', 'inc-2')).toEqual(['replaced'])
    settle(false)
    expect(stops.claimExit('pty-1', 'inc-2')).toEqual([])
  })

  it('labels one exit with every kind of stop that overlapped on it', () => {
    const stops = new TerminalIntentionalStops()
    const settleSleep = stops.mark('pty-1', 'reversible', 'inc-1')
    const settleRestart = stops.mark('pty-1', 'replaced', 'inc-1')

    expect(stops.isReversibleStopInFlight('pty-1')).toBe(true)
    expect(stops.claimExit('pty-1', 'inc-1')).toEqual(['reversible', 'replaced'])

    settleSleep(true)
    expect(stops.isReversibleStopInFlight('pty-1')).toBe(false)
    settleRestart(false)
    expect(stops.claimExit('pty-1', 'inc-1')).toEqual(['reversible'])
  })

  it('keeps a landed stop when a later stop of the same process fails', () => {
    const stops = new TerminalIntentionalStops()
    stops.mark('pty-1', 'reversible', 'inc-1')(true)

    stops.mark('pty-1', 'reversible', 'inc-1')(false)

    expect(stops.claimExit('pty-1', 'inc-1')).toEqual(['reversible'])
  })
})
