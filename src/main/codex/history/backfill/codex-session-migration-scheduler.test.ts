import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexSessionBackfillOptions } from './codex-session-backfill-types'
import { createCodexSessionMigrationScheduler } from './codex-session-migration-scheduler'

describe('createCodexSessionMigrationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('publishes the baseline while a Codex pane is still open', async () => {
    vi.setSystemTime(new Date('2026-08-05T10:00:00Z'))
    const prepareScheduledRun = vi.fn()
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      prepareScheduledRun,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.beginLaunch('pty-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledOnce())

    const options = startBackfill.mock.calls[0]?.[0]
    expect(options?.retainPendingScanDates).toBe(true)
    expect(options?.canWriteCompletionMarker?.()).toBe(true)
    expect(prepareScheduledRun).toHaveBeenCalledWith([['2026', '08', '05']])
  })

  it('keeps launch passes full when no completed baseline can cover older failures', async () => {
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.scheduleRun(true)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ scanDates: undefined }),
      undefined
    )
  })

  it('upgrades a bounded pass when its target changed before the timer fired', async () => {
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => '/moved-history',
      prepareScheduledRun: () => true,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.scheduleRun()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ scanDates: undefined }),
      '/moved-history'
    )
  })

  it('preserves a delayed launch rerun while an earlier migration is active', async () => {
    let releaseFirstIndexHeal: (() => void) | undefined
    const prepareScheduledRun = vi.fn()
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const startIndexHeal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstIndexHeal = resolve
          })
      )
      .mockResolvedValueOnce(null)
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      prepareScheduledRun,
      startBackfill,
      startIndexHeal,
      initialDelayMs: 1_000
    })

    scheduler.requestRun()
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledOnce())

    scheduler.scheduleRun()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenCalledOnce()
    expect(prepareScheduledRun).not.toHaveBeenCalled()

    releaseFirstIndexHeal?.()
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledTimes(2))
    expect(prepareScheduledRun).toHaveBeenCalledOnce()
    expect(prepareScheduledRun.mock.invocationCallOrder[0]).toBeLessThan(
      startBackfill.mock.invocationCallOrder[1]!
    )
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
      startIndexHeal
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
      startIndexHeal
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

  it('finishes a launch generation only after its PTY exits and every date is rescanned', async () => {
    vi.setSystemTime(new Date('2026-08-05T23:59:59Z'))
    const finishScheduledRun = vi.fn()
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      prepareScheduledRun: vi.fn(),
      finishScheduledRun,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.beginLaunch('pty-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledOnce())
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ retainPendingScanDates: true }),
      undefined
    )
    expect(finishScheduledRun).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-08-07T01:00:00Z'))
    scheduler.finishLaunch('pty-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledTimes(2))
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scanDates: [
          ['2026', '08', '05'],
          ['2026', '08', '06'],
          ['2026', '08', '07']
        ],
        ignoreCompletionMarker: true,
        retainPendingScanDates: false,
        fullScanRequired: false
      }),
      undefined
    )
    await vi.waitFor(() => expect(finishScheduledRun).toHaveBeenCalledOnce())
  })

  it('keeps a failed full scan required for the final launch pass', async () => {
    const finishScheduledRun = vi.fn()
    const startBackfill = vi
      .fn()
      .mockResolvedValueOnce({ stopped: false, failedFiles: 1 })
      .mockResolvedValueOnce({ stopped: false, failedFiles: 0 })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      prepareScheduledRun: () => false,
      finishScheduledRun,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.beginLaunch('pty-1', true)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledOnce())
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ scanDates: undefined, fullScanRequired: true }),
      undefined
    )

    scheduler.finishLaunch('pty-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledTimes(2))
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ scanDates: undefined, fullScanRequired: true }),
      undefined
    )
    await vi.waitFor(() => expect(finishScheduledRun).toHaveBeenCalledOnce())
  })

  it('blocks marker publication when a newer launch pass is pending', async () => {
    let releaseBackfill: ((result: { stopped: boolean }) => void) | undefined
    const startBackfill = vi.fn(
      (_options: CodexSessionBackfillOptions) =>
        new Promise<{ stopped: boolean }>((resolve) => {
          releaseBackfill = resolve
        })
    )
    const startIndexHeal = vi.fn().mockResolvedValue(null)
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal,
      initialDelayMs: 1_000
    })

    scheduler.scheduleRun()
    await vi.advanceTimersByTimeAsync(1_000)
    const firstOptions = startBackfill.mock.calls[0]?.[0]
    expect(firstOptions?.canWriteCompletionMarker?.()).toBe(true)

    scheduler.beginLaunch('pty-2')
    expect(firstOptions?.canWriteCompletionMarker?.()).toBe(false)
    scheduler.finishLaunch('pty-2')
    expect(firstOptions?.canWriteCompletionMarker?.()).toBe(false)

    releaseBackfill?.({ stopped: false })
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledOnce())
  })

  it('turns an exit-before-begin race into a full recovery pass', async () => {
    const finishScheduledRun = vi.fn()
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      finishScheduledRun,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.finishLaunch('pty-fast-exit', 2)
    scheduler.beginLaunch('pty-fast-exit', false, new Date(), 1)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ scanDates: undefined, fullScanRequired: true }),
      undefined
    )
    await vi.waitFor(() => expect(finishScheduledRun).toHaveBeenCalledOnce())
  })

  it('keeps a newer same-ID launch active while the ignored incarnation exits', async () => {
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.ignoreLaunch('stable-pty', 1)
    scheduler.beginLaunch('stable-pty', false, new Date(), 2)
    scheduler.finishLaunch('stable-pty', 3)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ retainPendingScanDates: true }),
      undefined
    )

    scheduler.finishLaunch('stable-pty', 4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ retainPendingScanDates: false }),
      undefined
    )
  })

  it('releases a stranded active launch once the ignored incarnation ages out', async () => {
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.ignoreLaunch('stable-pty', 1)
    scheduler.beginLaunch('stable-pty', false, new Date(), 2)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ retainPendingScanDates: true }),
      undefined
    )

    scheduler.finishLaunch('stable-pty', 3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ retainPendingScanDates: false }),
      undefined
    )
  })

  it('does not consume an exit from an earlier stable-id incarnation', async () => {
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.finishLaunch('stable-pty', 1)
    scheduler.beginLaunch('stable-pty', false, new Date(), 2)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ retainPendingScanDates: true }),
      undefined
    )
  })
})
