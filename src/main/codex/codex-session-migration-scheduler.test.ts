import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexSessionBackfillOptions } from './codex-session-backfill-types'
import { createCodexSessionMigrationScheduler } from './codex-session-migration-scheduler'

describe('createCodexSessionMigrationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('runs after a managed-account startup switches to host system default', async () => {
    let eligible = false
    const prepareScheduledRun = vi.fn()
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const startIndexHeal = vi.fn().mockResolvedValue(null)
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => eligible,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      prepareScheduledRun,
      startBackfill,
      startIndexHeal
    })

    scheduler.scheduleInitialRun()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(startBackfill).not.toHaveBeenCalled()

    eligible = true
    scheduler.requestRun()
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledOnce())
    expect(startBackfill).toHaveBeenCalledOnce()
    expect(prepareScheduledRun).not.toHaveBeenCalled()
  })

  it('schedules a delayed rerun after a shared-home launch', async () => {
    vi.setSystemTime(new Date(2026, 7, 5, 10, 0, 0))
    const prepareScheduledRun = vi.fn()
    const finishScheduledRun = vi.fn()
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const startIndexHeal = vi.fn().mockResolvedValue(null)
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      prepareScheduledRun,
      finishScheduledRun,
      startBackfill,
      startIndexHeal,
      initialDelayMs: 1_000
    })

    scheduler.scheduleRun()
    scheduler.scheduleRun()
    await vi.advanceTimersByTimeAsync(999)
    expect(startBackfill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledOnce())
    expect(startBackfill).toHaveBeenCalledOnce()
    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        scanDates: [['2026', '08', '05']],
        ignoreCompletionMarker: true
      }),
      undefined
    )
    expect(prepareScheduledRun).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(finishScheduledRun).toHaveBeenCalledOnce())
  })

  it('covers both launch and run dates when a delayed pass crosses midnight', async () => {
    vi.setSystemTime(new Date('2026-08-05T23:59:59.500Z'))
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.scheduleRun()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        scanDates: [
          ['2026', '08', '05'],
          ['2026', '08', '06']
        ]
      }),
      undefined
    )
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

  it('delays the startup run from the latest shared-home launch', async () => {
    const prepareScheduledRun = vi.fn()
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const startIndexHeal = vi.fn().mockResolvedValue(null)
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      prepareScheduledRun,
      startBackfill,
      startIndexHeal,
      initialDelayMs: 1_000
    })

    scheduler.scheduleInitialRun()
    await vi.advanceTimersByTimeAsync(999)
    scheduler.scheduleRun()

    await vi.advanceTimersByTimeAsync(1)
    expect(startBackfill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(999)
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledOnce())
    expect(startBackfill).toHaveBeenCalledOnce()
    expect(prepareScheduledRun).toHaveBeenCalledOnce()
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

  it('prepares a delayed launch pass after an earlier migration settles before the timer', async () => {
    let releaseFirstBackfill: (() => void) | undefined
    let markerPresent = false
    const prepareScheduledRun = vi.fn(() => {
      markerPresent = false
    })
    const startBackfill = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstBackfill = () => {
              markerPresent = true
              resolve()
            }
          })
      )
      .mockImplementationOnce(async () => {
        expect(markerPresent).toBe(false)
      })
    const startIndexHeal = vi.fn().mockResolvedValue(null)
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
    scheduler.scheduleRun()
    releaseFirstBackfill?.()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(markerPresent).toBe(true)
    expect(startIndexHeal).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledTimes(2))
    expect(prepareScheduledRun).toHaveBeenCalledOnce()
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

  it('preserves scheduled identity and target recovery after a stopped pass', async () => {
    let eligible = true
    let target = '/old-history'
    let releaseFirstBackfill: ((result: { stopped: boolean }) => void) | undefined
    const prepareScheduledRun = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const finishScheduledRun = vi.fn()
    const startBackfill = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ stopped: boolean }>((resolve) => {
            releaseFirstBackfill = resolve
          })
      )
      .mockResolvedValueOnce({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => eligible,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => target,
      prepareScheduledRun,
      finishScheduledRun,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.scheduleRun()
    await vi.advanceTimersByTimeAsync(1_000)
    const firstOptions = startBackfill.mock.calls[0]?.[0]
    eligible = false
    expect(firstOptions?.shouldStop()).toBe(true)
    target = '/new-history'
    releaseFirstBackfill?.({ stopped: true })
    await vi.waitFor(() => expect(prepareScheduledRun).toHaveBeenCalledOnce())
    expect(finishScheduledRun).not.toHaveBeenCalled()

    eligible = true
    scheduler.requestRun()
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledTimes(2))
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ ignoreCompletionMarker: true, scanDates: undefined }),
      '/new-history'
    )
    await vi.waitFor(() => expect(finishScheduledRun).toHaveBeenCalledOnce())
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
      expect.objectContaining({ writeCompletionMarker: false }),
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
        writeCompletionMarker: true,
        writeBoundedCompletionMarker: true
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
      expect.objectContaining({ scanDates: undefined, writeBoundedCompletionMarker: false }),
      undefined
    )

    scheduler.finishLaunch('pty-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledTimes(2))
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ scanDates: undefined, writeBoundedCompletionMarker: false }),
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
      expect.objectContaining({ scanDates: undefined, writeBoundedCompletionMarker: false }),
      undefined
    )
    await vi.waitFor(() => expect(finishScheduledRun).toHaveBeenCalledOnce())
  })

  it('keeps an ignored reattach exit from poisoning a same-ID launch already starting', async () => {
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
    scheduler.finishLaunch('stable-pty', 3)
    scheduler.beginLaunch('stable-pty', false, new Date(), 2)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        scanDates: expect.any(Array),
        writeCompletionMarker: false,
        writeBoundedCompletionMarker: false
      }),
      undefined
    )
  })

  it('matches an ignored reattach exit that arrived before its lifecycle callback', async () => {
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.finishLaunch('stable-pty', 2)
    scheduler.ignoreLaunch('stable-pty', 1)
    scheduler.beginLaunch('stable-pty', false, new Date(), 3)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        scanDates: expect.any(Array),
        writeCompletionMarker: false,
        writeBoundedCompletionMarker: false
      }),
      undefined
    )
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
      expect.objectContaining({ writeCompletionMarker: false }),
      undefined
    )

    scheduler.finishLaunch('stable-pty', 4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ writeCompletionMarker: true }),
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

    // The ignored incarnation never reports its exit, so only the newer launch ever finishes.
    scheduler.ignoreLaunch('stable-pty', 1)
    scheduler.beginLaunch('stable-pty', false, new Date(), 2)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ writeCompletionMarker: false }),
      undefined
    )

    scheduler.finishLaunch('stable-pty', 3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ writeCompletionMarker: true }),
      undefined
    )
  })

  it('keeps late duplicate ignored callbacks from poisoning reuse', async () => {
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
    scheduler.finishLaunch('stable-pty', 3)
    scheduler.ignoreLaunch('stable-pty', 2)
    scheduler.ignoreLaunch('stable-pty', 2)
    scheduler.beginLaunch('stable-pty', false, new Date(), 4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenCalledTimes(1)

    scheduler.finishLaunch('stable-pty', 5)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenCalledTimes(2)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ writeCompletionMarker: true }),
      undefined
    )
  })

  it('keeps three exit-before-callback reattaches from stranding a reused ID', async () => {
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.finishLaunch('stable-pty', 4)
    scheduler.ignoreLaunch('stable-pty', 1)
    scheduler.ignoreLaunch('stable-pty', 2)
    scheduler.ignoreLaunch('stable-pty', 3)
    scheduler.beginLaunch('stable-pty', false, new Date(), 5)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ writeCompletionMarker: false }),
      undefined
    )

    scheduler.finishLaunch('stable-pty', 6)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startBackfill).toHaveBeenCalledTimes(2)
    expect(startBackfill).toHaveBeenLastCalledWith(
      expect.objectContaining({ writeCompletionMarker: true }),
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
      expect.objectContaining({ writeCompletionMarker: false }),
      undefined
    )
  })

  it('preserves the pre-spawn UTC date when launch setup crosses midnight', async () => {
    vi.setSystemTime(new Date('2026-08-06T00:00:01Z'))
    const startBackfill = vi.fn().mockResolvedValue({ stopped: false })
    const scheduler = createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal: vi.fn().mockResolvedValue(null),
      initialDelayMs: 1_000
    })

    scheduler.beginLaunch('pty-midnight', false, new Date('2026-08-05T23:59:59Z'))
    scheduler.finishLaunch('pty-midnight')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(startBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        scanDates: [
          ['2026', '08', '05'],
          ['2026', '08', '06']
        ]
      }),
      undefined
    )
  })
})
