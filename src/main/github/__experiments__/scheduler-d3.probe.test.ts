/**
 * DISPOSABLE EXPERIMENT (STA-8667 D3). Scheduler probes on the real renderer scheduler source
 * (see scheduler-patches.ts for the exact diffs). Fake timers; no network, no subprocess.
 * Each case reports what base / d2 / d3 do, then asserts the D3 contract.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHintStore, schedulerFactory, type SchedulerVariant } from './scheduler-patches'

type Target = {
  key: string
  revision: string
  fetchedAt: number | null
  intervalMs: number | null
  selected: boolean
  nextRefreshAt?: number | null
  refresh: (force?: boolean, signal?: AbortSignal) => Promise<boolean>
}

const T = 1_000_000
const out: Record<string, unknown> = {}
const VARIANTS: SchedulerVariant[] = ['base', 'd2', 'd3']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(T)
})
afterEach(() => vi.useRealTimers())

async function each<R>(run: (variant: SchedulerVariant, make: Awaited<ReturnType<typeof schedulerFactory>>) => Promise<R>) {
  const r = {} as Record<SchedulerVariant, R>
  for (const v of VARIANTS) {
    vi.setSystemTime(T)
    r[v] = await run(v, await schedulerFactory(v))
  }
  return r
}

it('D2-1: a retained hint must not arm a timer once the target has no timed interval', async () => {
  const r = await each(async (_v, make) => {
    const calls: number[] = []
    const s = make()
    const target = (intervalMs: number | null): Target => ({
      key: 'a', revision: 'h1', fetchedAt: T, intervalMs, selected: false, nextRefreshAt: T + 300_000,
      refresh: async () => { calls.push(Date.now()); return true }
    })
    s.update([target(120_000)] as never)
    s.setVisible(true)
    await vi.advanceTimersByTimeAsync(10_000)
    // The row stops having a timed read (unfocused pause, or merged and settled). Same hint kept.
    s.update([target(null)] as never)
    await vi.advanceTimersByTimeAsync(600_000)
    s.dispose()
    return { refreshCallsAfterStop: calls.map((c) => c - T) }
  })
  out['d2-1 hint vs no-timer (existing successful cache)'] = r
  expect(r.d2.refreshCallsAfterStop).toEqual([300_000])
  expect(r.d3.refreshCallsAfterStop).toEqual([])
})

it('D2-1: same for a cold-deferred hint (no data yet)', async () => {
  const r = await each(async (_v, make) => {
    const calls: number[] = []
    const s = make()
    const target = (intervalMs: number | null, hint: number | null): Target => ({
      key: 'a', revision: 'h1', fetchedAt: null, intervalMs, selected: false, nextRefreshAt: hint,
      refresh: async () => { calls.push(Date.now() - T); return true } // "deferred" counts as success
    })
    s.update([target(120_000, null)] as never)
    s.setVisible(true)
    await vi.advanceTimersByTimeAsync(1_000) // first read answered `deferred`, hint T+200 s
    s.update([target(120_000, T + 200_000)] as never)
    await vi.advanceTimersByTimeAsync(20_000)
    s.update([target(null, T + 200_000)] as never) // pause begins before the hint is reached
    await vi.advanceTimersByTimeAsync(600_000)
    s.dispose()
    return { refreshCalls: calls }
  })
  out['d2-1 hint vs no-timer (cold deferred)'] = r
  expect(r.d2.refreshCalls).toEqual([0, 200_000])
  expect(r.d3.refreshCalls).toEqual([0])
})

it('D2-1: a hint still paces a timed target, and a slower hint is dropped when the target speeds up', async () => {
  const r = await each(async (_v, make) => {
    const calls: number[] = []
    const s = make()
    const target = (hint: number | null): Target => ({
      key: 'a', revision: 'h1', fetchedAt: T, intervalMs: 60_000, selected: true, nextRefreshAt: hint,
      refresh: async () => { calls.push(Date.now() - T); return true }
    })
    s.update([target(T + 900_000)] as never)
    s.setVisible(true)
    await vi.advanceTimersByTimeAsync(100_000)
    const before = [...calls]
    // The client retires the hint (CI started: identity/epoch change) and passes none.
    s.update([target(null)] as never)
    await vi.advanceTimersByTimeAsync(100_000)
    s.dispose()
    return { callsWhileHinted: before, callsAfterHintRetired: calls.slice(before.length) }
  })
  out['d2-1 hint honoured while valid, retired on speed-up'] = r
  expect(r.d3.callsWhileHinted).toEqual([])
  expect(r.d3.callsAfterHintRetired.length).toBeGreaterThan(0)
})

it('D2-1: a late reply from before an invalidation cannot reinstall a hint', () => {
  const h = createHintStore()
  const startedIn = h.epoch('a')
  h.invalidateAll() // unfocused pause began while the request was in flight
  const installed = h.note('a', T + 300_000, startedIn, T)
  const afterPause = h.get('a', T)
  const e2 = h.epoch('a')
  h.note('a', T + 300_000, e2, T)
  const valid = h.get('a', T)
  const afterNewerData = h.get('a', T + 5) // cache advanced through another path
  h.invalidate('a') // identity or selection change for this key only
  const afterIdentityChange = h.get('a', T)
  h.note('a', null, h.epoch('a'), T)
  const hostSaysNoTimer = h.get('a', T)
  const r = { installed, afterPause, valid, afterNewerData, afterIdentityChange, hostSaysNoTimer }
  out['d2-1 hint store: late reply, newer data, identity change, explicit null'] = r
  expect(r).toEqual({ installed: false, afterPause: undefined, valid: T + 300_000, afterNewerData: undefined, afterIdentityChange: undefined, hostSaysNoTimer: null })
})

it('R-C4-1: a failed completion for identity A must not clear the pending discovery of identity B', async () => {
  for (const intervalMs of [null, 120_000]) {
    const r = await each(async (_v, make) => {
      const calls: string[] = []
      let failA: (() => void) | null = null
      const s = make()
      const target = (revision: string): Target => ({
        key: 'a', revision, fetchedAt: T - 500_000, intervalMs, selected: true,
        refresh: (_f, _sig) => {
          calls.push(`${revision}@${Date.now() - T}`)
          return revision === 'A' ? new Promise<boolean>((resolve) => { failA = () => resolve(false) }) : Promise.resolve(true)
        }
      })
      s.update([target('A')] as never)
      s.setVisible(true) // A starts (stale -> discovery)
      await vi.advanceTimersByTimeAsync(2_000)
      s.update([target('B')] as never) // new HEAD / linked review while A is in flight
      await vi.advanceTimersByTimeAsync(1_000)
      failA?.()
      await vi.advanceTimersByTimeAsync(55_000)
      const within55s = [...calls]
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      s.dispose()
      return { readsWithin55s: within55s, readsWithin30min: calls }
    })
    out[`r-c4-1 stale failed completion (B interval ${intervalMs === null ? 'none' : '120 s'})`] = r
    expect(r.d3.readsWithin55s.map((c) => c[0])).toEqual(['A', 'B'])
    // At this commit the stale failure charges B a 60 s error retry instead of reading it at once.
    expect(r.base.readsWithin55s.map((c) => c[0])).toEqual(['A'])
  }
})

it('R-C4-3: window return and focus-only return read a selected target older than 60 s, whatever its hint', async () => {
  const r = await each(async (_v, make) => {
    const calls: string[] = []
    const s = make()
    const fetched: Record<string, number> = { selected: T - 90_000, merged: T - 16 * 60_000 }
    const targets = (): Target[] => [
      // Selected, settled, backed off: the host said "next timed read in 25 min".
      { key: 'selected', revision: 'h', fetchedAt: fetched.selected, intervalMs: 60_000, selected: true, nextRefreshAt: T + 25 * 60_000, refresh: read('selected') },
      // Not selected, merged and settled: no timed interval.
      { key: 'merged', revision: 'h', fetchedAt: fetched.merged, intervalMs: null, selected: false, refresh: read('merged') }
    ]
    const read = (key: string) => async (): Promise<boolean> => {
      calls.push(`${key}@${Math.round((Date.now() - T) / 1000)}s`)
      fetched[key] = Date.now()
      s.update(targets() as never)
      return true
    }
    s.update(targets() as never)
    s.setVisible(true)
    await vi.advanceTimersByTimeAsync(1_000)
    const onFirstShow = [...calls]
    s.setVisible(false)
    await vi.advanceTimersByTimeAsync(90_000)
    s.setVisible(true) // hidden -> visible after 90 s
    await vi.advanceTimersByTimeAsync(1_000)
    const onReturnAfter90s = calls.slice(onFirstShow.length)
    let onFocusOnlyAfter90s: string[] | 'no foreground() entry point' = 'no foreground() entry point'
    let onFocusOnlyAfter20s: string[] | 'no foreground() entry point' = 'no foreground() entry point'
    if (s.foreground) {
      let n = calls.length
      await vi.advanceTimersByTimeAsync(90_000)
      const timed = calls.slice(n)
      n = calls.length
      s.foreground() // focus regained, document stayed visible
      await vi.advanceTimersByTimeAsync(1_000)
      onFocusOnlyAfter90s = [...timed, ...calls.slice(n)]
      n = calls.length
      await vi.advanceTimersByTimeAsync(20_000)
      s.foreground()
      await vi.advanceTimersByTimeAsync(1_000)
      onFocusOnlyAfter20s = calls.slice(n)
    }
    s.dispose()
    return { onFirstShow, onReturnAfter90s, onFocusOnlyAfter90s, onFocusOnlyAfter20s }
  })
  out['r-c4-3 foreground freshness (hinted selected target, stopped target, focus-only)'] = r
  expect(r.d2.onReturnAfter90s.filter((c) => c.startsWith('selected'))).toEqual([]) // D2: the hint hides the return
  expect(r.d3.onReturnAfter90s).toEqual(['selected@91s'])
  expect(r.d3.onFocusOnlyAfter90s).toEqual(['selected@182s'])
  expect(r.d3.onFocusOnlyAfter20s).toEqual([])
})

it('write results', () => {
  const dir = process.env.EXP_OUT_DIR ?? path.resolve(__dirname, 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'scheduler-d3.probe.json'), JSON.stringify(out, null, 2))
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out))
})
