import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CRASH_FUSE_COOLDOWN_INITIAL_MS,
  CRASH_FUSE_COOLDOWN_MAX_MS,
  CRASH_FUSE_TRIAL_STABLE_MS,
  WatcherProcessCrashFuse
} from './parcel-watcher-crash-fuse'

function tripAt(fuse: WatcherProcessCrashFuse, start: number): void {
  fuse.recordCrash(start)
  fuse.recordCrash(start + 40_000)
  fuse.recordCrash(start + 80_000)
}

describe('WatcherProcessCrashFuse', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens after three crashes at the watcher restart cadence', () => {
    const fuse = new WatcherProcessCrashFuse()

    tripAt(fuse, 0)

    expect(fuse.isOpen(80_000)).toBe(true)
  })

  it('stays open for the cooldown, then half-opens to retry native watching', () => {
    const fuse = new WatcherProcessCrashFuse()
    tripAt(fuse, 0)
    const openedAt = 80_000

    expect(fuse.isOpen(openedAt + CRASH_FUSE_COOLDOWN_INITIAL_MS - 1)).toBe(true)
    expect(fuse.isOpen(openedAt + CRASH_FUSE_COOLDOWN_INITIAL_MS)).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('retrying native file watching')
    )
  })

  it('reopens on a single trial crash with a doubled, capped cooldown', () => {
    const fuse = new WatcherProcessCrashFuse()
    tripAt(fuse, 0)
    let openedAt = 80_000
    let cooldown = CRASH_FUSE_COOLDOWN_INITIAL_MS
    for (let trip = 0; trip < 6; trip++) {
      expect(fuse.isOpen(openedAt + cooldown - 1)).toBe(true)
      const trialAt = openedAt + cooldown
      expect(fuse.isOpen(trialAt)).toBe(false)
      openedAt = trialAt + 1_000
      fuse.recordCrash(openedAt)
      expect(fuse.isOpen(openedAt)).toBe(true)
      cooldown = Math.min(cooldown * 2, CRASH_FUSE_COOLDOWN_MAX_MS)
    }
    expect(fuse.isOpen(openedAt + CRASH_FUSE_COOLDOWN_MAX_MS - 1)).toBe(true)
    expect(cooldown).toBe(CRASH_FUSE_COOLDOWN_MAX_MS)
  })

  it('resets escalation only after the trial child confirms delivery for the stable period', () => {
    const fuse = new WatcherProcessCrashFuse()
    tripAt(fuse, 0)
    const trialAt = 80_000 + CRASH_FUSE_COOLDOWN_INITIAL_MS
    expect(fuse.isOpen(trialAt)).toBe(false)
    fuse.noteChildStarted()
    const healthyAt = trialAt + 60_000
    fuse.recordDeliveryHealth('healthy', healthyAt)

    expect(fuse.isOpen(healthyAt + CRASH_FUSE_TRIAL_STABLE_MS)).toBe(false)

    tripAt(fuse, healthyAt + CRASH_FUSE_TRIAL_STABLE_MS + 1)
    const reopenedAt = healthyAt + CRASH_FUSE_TRIAL_STABLE_MS + 1 + 80_000
    expect(fuse.isOpen(reopenedAt + CRASH_FUSE_COOLDOWN_INITIAL_MS - 1)).toBe(true)
    expect(fuse.isOpen(reopenedAt + CRASH_FUSE_COOLDOWN_INITIAL_MS)).toBe(false)
  })

  it('keeps escalating when the trial child survives without ever confirming delivery', () => {
    const fuse = new WatcherProcessCrashFuse()
    tripAt(fuse, 0)
    const trialAt = 80_000 + CRASH_FUSE_COOLDOWN_INITIAL_MS
    expect(fuse.isOpen(trialAt)).toBe(false)
    fuse.noteChildStarted()

    const crashAt = trialAt + 3 * CRASH_FUSE_TRIAL_STABLE_MS
    expect(fuse.isOpen(crashAt)).toBe(false)
    fuse.recordCrash(crashAt)

    expect(fuse.isOpen(crashAt + 2 * CRASH_FUSE_COOLDOWN_INITIAL_MS - 1)).toBe(true)
  })

  it('does not count a stalled stretch toward the stable period', () => {
    const fuse = new WatcherProcessCrashFuse()
    tripAt(fuse, 0)
    const trialAt = 80_000 + CRASH_FUSE_COOLDOWN_INITIAL_MS
    expect(fuse.isOpen(trialAt)).toBe(false)
    fuse.recordDeliveryHealth('healthy', trialAt)
    fuse.recordDeliveryHealth('stalled', trialAt + CRASH_FUSE_TRIAL_STABLE_MS - 1)

    const crashAt = trialAt + 2 * CRASH_FUSE_TRIAL_STABLE_MS
    expect(fuse.isOpen(crashAt)).toBe(false)
    fuse.recordCrash(crashAt)

    expect(fuse.isOpen(crashAt + 2 * CRASH_FUSE_COOLDOWN_INITIAL_MS - 1)).toBe(true)
  })

  it('neither starts nor clears the stable period on an unknown report', () => {
    const fuse = new WatcherProcessCrashFuse()
    tripAt(fuse, 0)
    const trialAt = 80_000 + CRASH_FUSE_COOLDOWN_INITIAL_MS
    expect(fuse.isOpen(trialAt)).toBe(false)
    fuse.recordDeliveryHealth('unknown', trialAt)
    const crashAt = trialAt + 2 * CRASH_FUSE_TRIAL_STABLE_MS
    expect(fuse.isOpen(crashAt)).toBe(false)
    fuse.recordCrash(crashAt)
    expect(fuse.isOpen(crashAt + 2 * CRASH_FUSE_COOLDOWN_INITIAL_MS - 1)).toBe(true)

    const nextTrialAt = crashAt + 2 * CRASH_FUSE_COOLDOWN_INITIAL_MS
    expect(fuse.isOpen(nextTrialAt)).toBe(false)
    fuse.recordDeliveryHealth('healthy', nextTrialAt)
    fuse.recordDeliveryHealth('unknown', nextTrialAt + CRASH_FUSE_TRIAL_STABLE_MS - 1)
    const stableAt = nextTrialAt + CRASH_FUSE_TRIAL_STABLE_MS
    expect(fuse.isOpen(stableAt)).toBe(false)
    fuse.recordCrash(stableAt + 1)
    expect(fuse.isOpen(stableAt + 1)).toBe(false)
  })

  it('closes immediately when explicitly reset', () => {
    const fuse = new WatcherProcessCrashFuse()
    tripAt(fuse, 0)

    fuse.reset()
    expect(fuse.isOpen(80_000)).toBe(false)
  })

  it('expires crashes outside the two-minute window', () => {
    const fuse = new WatcherProcessCrashFuse()

    fuse.recordCrash(0)
    fuse.recordCrash(40_000)
    fuse.recordCrash(120_000)

    expect(fuse.isOpen(120_000)).toBe(false)
  })
})
