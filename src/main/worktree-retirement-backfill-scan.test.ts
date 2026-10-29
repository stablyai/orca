import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS,
  RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS,
  type RetirementScanResult,
  runRetirementBackfillScan
} from './worktree-retirement-backfill-scan'

const found = (names: string[], complete = true): RetirementScanResult => ({
  names: new Set(names),
  complete
})

function stallingScan(): {
  run: () => Promise<RetirementScanResult>
  finish: (names: string[]) => void
  fail: () => void
} {
  let settle: (result: RetirementScanResult) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  return {
    run: () =>
      new Promise<RetirementScanResult>((resolve, rejectScan) => {
        settle = resolve
        reject = rejectScan
      }),
    finish: (names) => settle(found(names)),
    fail: () => reject(new Error('EIO'))
  }
}

async function stallPastDeadline(store: WeakKey, scanKey: string) {
  const scan = stallingScan()
  const pending = runRetirementBackfillScan(store, scanKey, scan.run)
  const settled = expect(pending).rejects.toThrow(/exceeded/)
  await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
  await settled
  return scan
}

describe('runRetirementBackfillScan', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a listing that never returns instead of blocking create forever', async () => {
    await stallPastDeadline({}, 'ns')
  })

  it('does not stack a second listing while the first is still stuck', async () => {
    const store = {}
    await stallPastDeadline(store, 'ns')
    const retry = vi.fn(async () => found(['nautilus']))

    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS * 10)

    await expect(runRetirementBackfillScan(store, 'ns', retry)).rejects.toThrow(/exceeded/)
    expect(retry).not.toHaveBeenCalled()
  })

  it('retries once the stuck listing settles and the backoff has lapsed', async () => {
    const store = {}
    const stalled = await stallPastDeadline(store, 'ns')
    const retry = vi.fn(async () => found(['nautilus']))

    stalled.fail()
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS)

    await expect(runRetirementBackfillScan(store, 'ns', retry)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('serves the failure from the memo until the backoff lapses', async () => {
    const store = {}
    const stalled = await stallPastDeadline(store, 'ns')
    const retry = vi.fn(async () => found(['nautilus']))

    // Settle the listing first so the test exercises backoff, not the no-restack guard.
    stalled.fail()
    await vi.advanceTimersByTimeAsync(0)

    await expect(runRetirementBackfillScan(store, 'ns', retry)).rejects.toThrow(/exceeded/)
    expect(retry).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS)
    await expect(runRetirementBackfillScan(store, 'ns', retry)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('never lets one wedged namespace stop another from scanning', async () => {
    const store = {}
    await stallPastDeadline(store, 'stuck-a')
    await stallPastDeadline(store, 'stuck-b')
    await stallPastDeadline(store, 'stuck-c')

    const healthy = vi.fn(async () => found(['nautilus']))
    await expect(runRetirementBackfillScan(store, 'healthy-ns', healthy)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('scans a namespace once and shares the answer with every later caller', async () => {
    const store = {}
    const scan = vi.fn(async () => found(['nautilus']))

    await expect(runRetirementBackfillScan(store, 'ns', scan)).resolves.toEqual(
      new Set(['nautilus'])
    )
    await expect(runRetirementBackfillScan(store, 'ns', scan)).resolves.toEqual(
      new Set(['nautilus'])
    )

    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('keeps a listing that lands after the deadline instead of discarding the answer', async () => {
    // WSL scan admission can exceed this deadline while still returning a valid answer.
    const store = {}
    const slow = await stallPastDeadline(store, 'ns')
    const rescan = vi.fn(async () => found(['orca']))

    slow.finish(['nautilus'])
    await vi.advanceTimersByTimeAsync(0)

    await expect(runRetirementBackfillScan(store, 'ns', rescan)).resolves.toEqual(
      new Set(['nautilus'])
    )
    expect(rescan).not.toHaveBeenCalled()
  })

  it('does not memoize an incomplete answer, so a refused source is retried', async () => {
    const store = {}
    const partial = vi.fn(async () => found(['nautilus'], false))
    const whole = vi.fn(async () => found(['nautilus', 'orca']))

    await expect(runRetirementBackfillScan(store, 'ns', partial)).resolves.toEqual(
      new Set(['nautilus'])
    )

    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS)
    await expect(runRetirementBackfillScan(store, 'ns', whole)).resolves.toEqual(
      new Set(['nautilus', 'orca'])
    )
  })

  it('does not let one store inherit another store scan memo', async () => {
    const first = vi.fn(async () => found(['nautilus']))
    const second = vi.fn(async () => found(['orca']))

    await runRetirementBackfillScan({}, 'ns', first)
    await expect(runRetirementBackfillScan({}, 'ns', second)).resolves.toEqual(new Set(['orca']))
  })
})
