import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexSessionMigrationScheduler } from './codex-session-migration-scheduler'

describe('createCodexSessionMigrationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('runs after a managed-account startup switches to host system default', async () => {
    let eligible = false
    const startBackfill = vi.fn().mockResolvedValue(null)
    const startIndexHeal = vi.fn().mockResolvedValue(null)
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => eligible,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal,
      startStateDbPrewarm: vi.fn(async () => null)
    })

    scheduler.scheduleInitialRun()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(startBackfill).not.toHaveBeenCalled()

    eligible = true
    scheduler.requestRun()
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledOnce())
    expect(startBackfill).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent run requests and stops before index heal after opt-out', async () => {
    let eligible = true
    let releaseBackfill: (() => void) | undefined
    const startBackfill = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseBackfill = resolve
        })
    )
    const startIndexHeal = vi.fn().mockResolvedValue(null)
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => eligible,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => '/custom/history',
      startBackfill,
      startIndexHeal,
      startStateDbPrewarm: vi.fn(async () => null)
    })

    scheduler.requestRun()
    scheduler.requestRun()
    expect(startBackfill).toHaveBeenCalledOnce()
    expect(startBackfill).toHaveBeenCalledWith(expect.any(Object), '/custom/history')

    eligible = false
    releaseBackfill?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(startIndexHeal).not.toHaveBeenCalled()
  })

  it('reruns after a stopping migration becomes eligible again', async () => {
    let eligible = true
    let releaseFirstBackfill: ((result: { stopped: boolean }) => void) | undefined
    const startBackfill = vi
      .fn()
      .mockImplementationOnce(
        (_options) =>
          new Promise<{ stopped: boolean }>((resolve) => {
            releaseFirstBackfill = resolve
          })
      )
      .mockResolvedValueOnce({ stopped: false })
    const startIndexHeal = vi.fn().mockResolvedValue(null)
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => eligible,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal,
      startStateDbPrewarm: vi.fn(async () => null)
    })

    scheduler.requestRun()
    const firstRunOptions = startBackfill.mock.calls[0]?.[0]
    eligible = false
    expect(firstRunOptions?.shouldStop()).toBe(true)
    eligible = true
    scheduler.requestRun()
    releaseFirstBackfill?.({ stopped: true })

    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledOnce())
  })

  it('runs the state-db prewarm after backfill and index-heal complete', async () => {
    const order: string[] = []
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill: vi.fn(async () => {
        order.push('backfill')
        return null
      }),
      startIndexHeal: vi.fn(async () => {
        order.push('heal')
        return null
      }),
      startStateDbPrewarm: vi.fn(async () => {
        order.push('prewarm')
        return null
      }),
      initialDelayMs: 0
    })
    scheduler.requestRun()
    await vi.waitFor(() => expect(order).toEqual(['backfill', 'heal', 'prewarm']))
  })

  it('skips the prewarm when the backfill run was stopped', async () => {
    const startStateDbPrewarm = vi.fn(async () => null)
    const startIndexHeal = vi.fn(async () => null)
    // Why a deferred first result: the scheduler auto-reruns after a stopped backfill
    // (`rerunRequested || stoppedBackfill`), so an always-stopped mock would rerun forever.
    let releaseBackfill: ((result: { stopped: boolean }) => void) | undefined
    const startBackfill = vi.fn(
      () =>
        new Promise<{ stopped: boolean }>((resolve) => {
          releaseBackfill = resolve
        })
    )
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal,
      startStateDbPrewarm,
      initialDelayMs: 0
    })
    scheduler.requestRun()
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledOnce())
    // Why { stopped: true }: the exact shape isStoppedMigrationResult() recognizes.
    releaseBackfill?.({ stopped: true })
    // Why wait for the rerun's second call: it only fires after the first run's whole
    // chain settles via .finally, proving no later stage ran before the negatives below.
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledTimes(2))
    expect(startIndexHeal).not.toHaveBeenCalled()
    expect(startStateDbPrewarm).not.toHaveBeenCalled()
  })
})
