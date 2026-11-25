import { expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { UsageLimitRelaunchedCuts } from './structured-agent-session-usage-limit-relaunch'

const T = 1_800_000_000_000
const DAY = 86_400_000
const HOME_B = { variable: 'CODEX_HOME', path: '/homes/b' } as const

function weekly(usedPercent: number, updatedAt: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: { usedPercent, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    updatedAt,
    error: null,
    status: 'ok'
  }
}
const room = (at: number) => weekly(0, at)
const spent = (at: number) => weekly(100, at)

/** A cut at fence 1 whose chat has since launched at fence 2 on home B, first seen at T. */
function relaunched() {
  const cuts = new UsageLimitRelaunchedCuts()
  cuts.note('chat', 'cut', HOME_B, 2, T)
  return cuts
}

it('never counts a reading the live session reported as room', () => {
  const cuts = relaunched()
  const live = { ...room(T + 1_000), usageMetadata: { source: 'live-session' as const } }
  expect(cuts.roomAt('chat', 'cut', 'account-b', live, T + 1_000)).toBeUndefined()
  expect(cuts.roomAt('chat', 'cut', 'account-b', room(T + 2_000), T + 2_000)).toBe(T + 2_000)
})

it('stops counting room once it is older than the overdue window', () => {
  const cuts = relaunched()
  const reading = room(T + 1_000)
  expect(cuts.roomAt('chat', 'cut', 'account-b', reading, T + 1_000)).toBe(T + 1_000)
  expect(cuts.roomAt('chat', 'cut', 'account-b', reading, T + 1_000 + DAY)).toBe(T + 1_000)
  expect(cuts.roomAt('chat', 'cut', 'account-b', reading, T + 1_001 + DAY)).toBeUndefined()
  // A run of room longer than the window counts from a reading inside it.
  const later = room(T + 2_000 + DAY)
  expect(cuts.roomAt('chat', 'cut', 'account-b', later, T + 2_000 + DAY)).toBe(T + 2_000 + DAY)
})

it('counts room from the first reading of the account it now reads', () => {
  const cuts = relaunched()
  expect(cuts.roomAt('chat', 'cut', 'account-b', room(T + 1_000), T + 1_000)).toBe(T + 1_000)
  expect(cuts.roomAt('chat', 'cut', 'account-b', room(T + 5_000), T + 5_000)).toBe(T + 1_000)
  // Another login in the same home: its room starts over.
  expect(cuts.roomAt('chat', 'cut', 'account-c', room(T + 9_000), T + 9_000)).toBe(T + 9_000)
})

it('starts room over after a reading shows spending', () => {
  const cuts = relaunched()
  expect(cuts.roomAt('chat', 'cut', 'account-b', room(T + 1_000), T + 1_000)).toBe(T + 1_000)
  expect(cuts.roomAt('chat', 'cut', 'account-b', spent(T + 2_000), T + 2_000)).toBeUndefined()
  expect(cuts.roomAt('chat', 'cut', 'account-b', room(T + 3_000), T + 3_000)).toBe(T + 3_000)
})

it('ignores a windowless or failed reading and room that predates newer spending', () => {
  const cuts = relaunched()
  const windowless = { ...room(T + 1_000), weekly: null }
  expect(cuts.roomAt('chat', 'cut', 'account-b', windowless, T + 1_000)).toBeUndefined()
  const failed = { ...room(T + 2_000), status: 'error' as const, error: 'offline' }
  expect(cuts.roomAt('chat', 'cut', 'account-b', failed, T + 2_000)).toBeUndefined()
  expect(cuts.roomAt('chat', 'cut', 'account-b', spent(T + 4_000), T + 4_000)).toBeUndefined()
  expect(cuts.roomAt('chat', 'cut', 'account-b', room(T + 3_000), T + 5_000)).toBeUndefined()
})
