import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CRASH_FUSE_COOLDOWN_INITIAL_MS,
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
})
