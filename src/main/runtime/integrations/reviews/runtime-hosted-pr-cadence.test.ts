import { describe, expect, it, vi } from 'vitest'
import type { PRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
import { fixture, found, mocks, read } from './runtime-hosted-pr-snapshot-test-harness'

// The harness resets modules per test; change the cadence on that same instance, as the host's
// settings sync does.
async function setHostCadence(cadence: PRAutoRefreshCadence): Promise<void> {
  const policy = await import('../../../../shared/review-refresh-policy')
  const coordinator = await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
  policy.setPRAutoRefreshCadence(cadence)
  coordinator.retimePRRefreshesForCadence()
}

describe('hosted PR snapshots under the host’s auto-refresh cadence', () => {
  it('stretches a confirmed quiet result by the cadence, and keeps it while off', async () => {
    await setHostCadence('reduced')
    await read('quiet', 'active')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const confirmation = read('quiet')
    await vi.advanceTimersByTimeAsync(0)
    expect(await confirmation).toMatchObject({ fetchedAt: 301_000 })
    fixture.title = 'moved'
    // Quiet is five minutes on Default; Reduced keeps it for twenty-five.
    await vi.advanceTimersByTimeAsync(24 * 60_000)
    expect(await read('quiet')).toMatchObject({ pr: { title: 'before' }, fetchedAt: 301_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    const due = read('quiet')
    await vi.advanceTimersByTimeAsync(0)
    expect(await due).toMatchObject({ pr: { title: 'moved' } })

    await setHostCadence('off')
    const calls = mocks.resolve.mock.calls.length
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(await read('quiet')).toMatchObject({ pr: { title: 'moved' } })
    expect(mocks.resolve).toHaveBeenCalledTimes(calls)
    fixture.title = 'looked again'
    expect(await read('quiet', 'active')).toMatchObject({ pr: { title: 'looked again' } })
  })

  it('takes a failure’s retry off the timer while off and restores it from the failure time', async () => {
    await read('failing', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    mocks.resolve.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'offline',
      fetchedAt: Date.now()
    }))
    const failing = read('failing')
    await vi.advanceTimersByTimeAsync(0)
    // Failed at 61 s: the retry waits for the two-minute background interval.
    expect(await failing).toMatchObject({ kind: 'upstream-error', nextAutoRetryAt: 181_000 })

    await setHostCadence('off')
    const off = await read('failing')
    expect(off).toMatchObject({ kind: 'upstream-error' })
    expect(off).not.toHaveProperty('nextAutoRetryAt')
    await vi.advanceTimersByTimeAsync(10_000)
    await setHostCadence('default')
    expect(await read('failing')).toMatchObject({ nextAutoRetryAt: 181_000 })
    expect(mocks.resolve).toHaveBeenCalledTimes(2)

    mocks.resolve.mockImplementation(async () => found())
    fixture.title = 'recovered'
    await vi.advanceTimersByTimeAsync(181_000 - Date.now())
    const recovered = read('failing')
    await vi.advanceTimersByTimeAsync(0)
    expect(await recovered).toMatchObject({ kind: 'found', pr: { title: 'recovered' } })
  })

  it('retires a queued revalidation when the host turns auto-refresh off', async () => {
    await read('queued', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    mocks.gate.mockResolvedValue(Date.now() + 120_000)
    const waiting = read('queued')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await waiting).toMatchObject({ fetchedAt: 1_000, revalidation: expect.any(Object) })

    await setHostCadence('off')
    mocks.gate.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)

    await setHostCadence('default')
    fixture.title = 'read again'
    const due = read('queued')
    await vi.advanceTimersByTimeAsync(0)
    expect(await due).toMatchObject({ pr: { title: 'read again' } })
  })
})
