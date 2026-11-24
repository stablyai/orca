import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AutomaticInstallAwayWait } from './automatic-install-away-wait'

const TEN_MINUTES_MS = 10 * 60_000

function setup(initial: { present: boolean; pending: boolean }) {
  const installs: string[] = []
  const state = { ...initial, installs }
  const wait = new AutomaticInstallAwayWait({
    mustWait: () => state.present,
    isPending: () => state.pending,
    install: () => {
      state.installs.push('2.0.0')
    }
  })
  return { state, wait }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it('holds the automatic restart while the user is present and installs once after they step away', () => {
  const { state, wait } = setup({ present: true, pending: true })

  expect(wait.holds('2.0.0')).toBe(true)
  vi.advanceTimersByTime(TEN_MINUTES_MS)
  expect(state.installs).toEqual([])

  state.present = false
  vi.advanceTimersByTime(60_000)
  expect(state.installs).toEqual(['2.0.0'])

  vi.advanceTimersByTime(TEN_MINUTES_MS)
  expect(state.installs).toEqual(['2.0.0'])
})

it('drops the wait when the downloaded update is no longer pending', () => {
  const { state, wait } = setup({ present: true, pending: true })

  expect(wait.holds('2.0.0')).toBe(true)
  state.pending = false
  state.present = false
  vi.advanceTimersByTime(TEN_MINUTES_MS)
  expect(state.installs).toEqual([])
})

it('does not hold when the user is already away', () => {
  const { state, wait } = setup({ present: false, pending: true })

  expect(wait.holds('2.0.0')).toBe(false)
  vi.advanceTimersByTime(TEN_MINUTES_MS)
  expect(state.installs).toEqual([])
})
