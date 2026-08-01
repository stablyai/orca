import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  countsTowardDurableGpuCrashHistory
} from '../crash-reporting/gpu-crash-fallback-decision'
import {
  DEFAULT_GPU_CRASH_DURABLE_WINDOW_MS,
  GPU_CRASH_HISTORY_FILE,
  inertGpuCrashHistoryDecision,
  MAX_GPU_CRASH_HISTORY_ENTRIES,
  appendGpuCrashTime,
  clearGpuCrashHistory,
  discardExpiredGpuCrashHistory,
  gpuCrashHistoryFileExists,
  pruneGpuCrashTimes,
  readGpuCrashHistory,
  evaluateGpuCrashHistory,
  persistGpuCrashTimes,
  sweepStaleGpuCrashHistoryTempFiles
} from './gpu-crash-history'
import type { GpuFallbackEnvironment } from './gpu-fallback-marker'

// Why mocked rather than chmod: a read-only parent directory does not stop an unlink
// on Windows, so the EPERM case this guards against would not reproduce there.
const removalFailure = vi.hoisted(() => ({ error: null as NodeJS.ErrnoException | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) =>
      removalFailure.error ? Promise.reject(removalFailure.error) : actual.rm(...args)
  }
})

const WINDOW = DEFAULT_GPU_CRASH_DURABLE_WINDOW_MS
const THRESHOLD = DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
const NOW = 1_800_000_000_000

describe('pruneGpuCrashTimes', () => {
  it('keeps only times inside the window, oldest first', () => {
    expect(pruneGpuCrashTimes([NOW - 100, NOW - WINDOW - 1, NOW - 50], NOW, WINDOW)).toEqual([
      NOW - 100,
      NOW - 50
    ])
  })

  it('keeps a time exactly on the window edge', () => {
    expect(pruneGpuCrashTimes([NOW - WINDOW], NOW, WINDOW)).toEqual([NOW - WINDOW])
  })

  it('drops values a clock jump or a corrupt file made nonsense', () => {
    // Why: these come off disk, so a NaN or a year-3000 stamp would otherwise pin
    // the count permanently over the threshold.
    const junk = [Number.NaN, Number.POSITIVE_INFINITY, -1, NOW + 86_400_000, '5', null, {}]
    expect(pruneGpuCrashTimes([...junk, NOW - 10], NOW, WINDOW)).toEqual([NOW - 10])
  })

  it('tolerates a small forward clock skew', () => {
    // NTP corrections move the wall clock by seconds; discarding those would drop
    // a crash that really did just happen.
    expect(pruneGpuCrashTimes([NOW + 5_000], NOW, WINDOW)).toEqual([NOW + 5_000])
  })

  it('returns nothing when `now` itself is unusable', () => {
    expect(pruneGpuCrashTimes([NOW], Number.NaN, WINDOW)).toEqual([])
  })

  it('drops entries stranded in the future by a backwards clock jump', () => {
    // Why this matters most: a rolling window only ever prunes the OLD end, so a
    // future-dated entry would sit in the window forever and two later crashes
    // would latch build-sticky safe graphics with no burst and no consent.
    const stored = [NOW - 30_000, NOW - 15_000, NOW]
    for (const jumpMs of [
      90_000, // NTP correction past the skew tolerance
      3_600_000, // hibernate / VM resume
      5 * 3_600_000 // dual-boot RTC skew: Windows local time vs Linux UTC
    ]) {
      const rewound = NOW - jumpMs
      const kept = pruneGpuCrashTimes(stored, rewound, WINDOW)
      // Nothing survives beyond the skew tolerance, so a rewind can never leave
      // enough entries to reach the threshold on its own.
      expect([jumpMs, kept.every((time) => time <= rewound + 60_000)]).toEqual([jumpMs, true])
      expect([jumpMs, kept.length < THRESHOLD]).toEqual([jumpMs, true])
    }

    // A rewind past the tolerance strands everything.
    expect(pruneGpuCrashTimes(stored, NOW - 3_600_000, WINDOW)).toEqual([])
    // Inside the tolerance, only what is genuinely near-present survives.
    expect(pruneGpuCrashTimes(stored, NOW - 90_000, WINDOW)).toEqual([NOW - 30_000])
  })

  it('cannot be pushed over the threshold by future-dated entries', () => {
    const rewound = NOW - 4 * 3_600_000
    const result = appendGpuCrashTime([NOW - 20_000, NOW - 10_000], rewound, {
      windowMs: WINDOW,
      threshold: THRESHOLD
    })
    // Only the crash that actually just happened survives.
    expect(result).toEqual({
      crashTimes: [rewound],
      crashesInWindow: 1,
      crossesThreshold: false
    })
  })

  it('does not let future-dated entries fill the cap and crowd out real crashes', () => {
    const rewound = NOW - 3_600_000
    const future = Array.from({ length: MAX_GPU_CRASH_HISTORY_ENTRIES * 2 }, (_, i) => NOW + i)
    const real = [rewound - 30_000, rewound - 15_000]
    const result = appendGpuCrashTime([...future, ...real], rewound, {
      windowMs: WINDOW,
      threshold: THRESHOLD
    })
    expect(result.crashTimes).toEqual([rewound - 30_000, rewound - 15_000, rewound])
    expect(result.crossesThreshold).toBe(true)
  })

  it('evicts oldest-first and still crosses the threshold at a full cap', () => {
    // Why: a cap that evicted the newest, or that sat below the threshold, would
    // silently suppress a machine crashing hard enough to overflow it.
    const many = Array.from({ length: MAX_GPU_CRASH_HISTORY_ENTRIES + 40 }, (_, i) => NOW - 100 + i)
    const result = appendGpuCrashTime(many, NOW, { windowMs: WINDOW, threshold: THRESHOLD })
    expect(result.crashTimes).toHaveLength(MAX_GPU_CRASH_HISTORY_ENTRIES)
    expect(result.crashTimes[0]).toBeGreaterThan(many[0])
    expect(result.crashTimes.at(-1)).toBe(NOW)
    expect(result.crossesThreshold).toBe(true)
    expect(MAX_GPU_CRASH_HISTORY_ENTRIES).toBeGreaterThan(THRESHOLD)
  })
})

describe('DEFAULT_GPU_CRASH_DURABLE_WINDOW_MS', () => {
  it('spans the measured crash-loop shape without reaching back hours', () => {
    // Measured: 18-24s median gap between consecutive crashing launches; the first
    // 8 crashes on F0BN5HZL8FJ span 96s. Three crashes need ~40-50s.
    expect(DEFAULT_GPU_CRASH_DURABLE_WINDOW_MS).toBeGreaterThan(2 * 24_000 * 3)
    // Every extra minute is false-positive surface, and the marker is written
    // before the user consents.
    expect(DEFAULT_GPU_CRASH_DURABLE_WINDOW_MS).toBeLessThanOrEqual(300_000)
  })

  it('reaches back 360s of real time once forward clock skew is counted', () => {
    // The number the doc comment has to argue against. The skew tolerance sits on the
    // young end of the window, so a stamp from a clock running 60s fast is accepted and
    // then gets the whole window from there: 360s of real elapsed time, not 300s.
    const skewed = NOW + 60_000
    expect(pruneGpuCrashTimes([skewed], NOW, WINDOW)).toEqual([skewed])
    expect(pruneGpuCrashTimes([NOW + 61_000], NOW, WINDOW)).toEqual([])
    expect(pruneGpuCrashTimes([skewed], NOW + 360_000, WINDOW)).toEqual([skewed])
    expect(pruneGpuCrashTimes([skewed], NOW + 361_000, WINDOW)).toEqual([])
  })
})

describe('appendGpuCrashTime', () => {
  it('does not cross the threshold before the third crash', () => {
    expect(appendGpuCrashTime([], NOW, { windowMs: WINDOW, threshold: THRESHOLD })).toMatchObject({
      crashesInWindow: 1,
      crossesThreshold: false
    })
    expect(
      appendGpuCrashTime([NOW - 20_000], NOW, { windowMs: WINDOW, threshold: THRESHOLD })
    ).toMatchObject({ crashesInWindow: 2, crossesThreshold: false })
  })

  it('crosses on the third crash spread across launches', () => {
    // The measured shape: one GPU death per launch, launches ~20s apart.
    const result = appendGpuCrashTime([NOW - 44_000, NOW - 22_000], NOW, {
      windowMs: WINDOW,
      threshold: THRESHOLD
    })
    expect(result).toMatchObject({ crashesInWindow: 3, crossesThreshold: true })
    expect(result.crashTimes).toEqual([NOW - 44_000, NOW - 22_000, NOW])
  })

  it('does not count crashes that aged out of the window', () => {
    expect(
      appendGpuCrashTime([NOW - WINDOW - 1, NOW - WINDOW - 2], NOW, {
        windowMs: WINDOW,
        threshold: THRESHOLD
      })
    ).toMatchObject({ crashesInWindow: 1, crossesThreshold: false })
  })

  it('bounds the array so a crash loop cannot grow the file', () => {
    const many = Array.from({ length: 200 }, (_, index) => NOW - 200 + index)
    const result = appendGpuCrashTime(many, NOW, { windowMs: WINDOW, threshold: THRESHOLD })
    expect(result.crashTimes).toHaveLength(MAX_GPU_CRASH_HISTORY_ENTRIES)
    // Why the newest: the dropped entries are the ones about to age out anyway.
    expect(result.crashTimes.at(-1)).toBe(NOW)
    expect(result.crashesInWindow).toBe(MAX_GPU_CRASH_HISTORY_ENTRIES)
  })

  it('never counts a crash time it refused to keep', () => {
    const result = appendGpuCrashTime([NOW - 10, NOW - 20], Number.NaN, {
      windowMs: WINDOW,
      threshold: THRESHOLD
    })
    expect(result).toEqual({ crashTimes: [], crashesInWindow: 0, crossesThreshold: false })
  })
})

describe('gpu-crash-history file', () => {
  let userDataPath: string
  const environment = {
    appVersion: '1.4.163',
    electronVersion: '42.3.3',
    platform: 'win32' as const
  }
  /** The production sequence for a crash that does not fire: evaluate, then persist. */
  const record = (now: number, env: GpuFallbackEnvironment = environment) => {
    const decision = evaluateGpuCrashHistory(userDataPath, env, {
      now,
      windowMs: WINDOW,
      threshold: THRESHOLD
    })
    persistGpuCrashTimes(userDataPath, env, decision.crashTimes)
    return decision
  }
  /**
   * The same sequence with handleGpuChildCrash's reason gate in front of it, so a
   * reason excluded from the durable history evaluates inert and writes nothing.
   * Mirrors index.ts; `desktop-startup-ordering` is what holds index.ts to this shape.
   */
  const recordForReason = (reason: string, now: number) => {
    const countsDurably = countsTowardDurableGpuCrashHistory(reason)
    const decision = countsDurably
      ? evaluateGpuCrashHistory(userDataPath, environment, {
          now,
          windowMs: WINDOW,
          threshold: THRESHOLD
        })
      : inertGpuCrashHistoryDecision()
    if (countsDurably) {
      persistGpuCrashTimes(userDataPath, environment, decision.crashTimes)
    }
    return decision
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-crash-history-test-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('accumulates across separate calls and fires on the third', () => {
    // The bug this exists for: three launches, one GPU death each, ~20s apart.
    expect(record(NOW).crossesThreshold).toBe(false)
    expect(record(NOW + 20_000).crossesThreshold).toBe(false)
    const third = record(NOW + 41_000)
    expect(third.crossesThreshold).toBe(true)
    expect(third.crashesInWindow).toBe(3)
  })

  it('evaluates without writing, so the fsync never precedes the marker write', () => {
    // Why load-bearing: the marker write races a kill that can land ~7ms after the
    // GPU failure, so the firing crash skips this write entirely.
    record(NOW)
    record(NOW + 1_000)
    const before = readFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), 'utf-8')

    const decision = evaluateGpuCrashHistory(userDataPath, environment, {
      now: NOW + 2_000,
      windowMs: WINDOW,
      threshold: THRESHOLD
    })

    expect(decision.crossesThreshold).toBe(true)
    expect(readFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), 'utf-8')).toBe(before)
  })

  it('is truncated to nothing by persisting an inert decision', () => {
    // Why asserted rather than commented: an excluded reason (`launch-failed`) makes
    // handleGpuChildCrash evaluate to inertGpuCrashHistoryDecision(), whose crashTimes
    // is []. Persisting that rewrites the file empty, so a single excluded GPU death
    // erases every real crash counted so far and the fallback never reaches three.
    // The persist must therefore stay gated on the reason counting durably.
    record(NOW)
    record(NOW + 1_000)
    expect(readGpuCrashHistory(userDataPath, environment)).toHaveLength(2)

    persistGpuCrashTimes(userDataPath, environment, inertGpuCrashHistoryDecision().crashTimes)

    expect(readGpuCrashHistory(userDataPath, environment)).toEqual([])
  })

  it('keeps the accumulated count when an excluded reason lands mid-sequence', () => {
    // Why mixed reasons: every other durable test drives one reason, so none composes
    // the gate with the count and the erasure above stays hypothetical. This is the
    // real sequence — two `crashed` deaths, then a `launch-failed` that must be ignored
    // rather than persisted over them, then the third `crashed` that still fires.
    expect(recordForReason('crashed', NOW).crossesThreshold).toBe(false)
    expect(recordForReason('crashed', NOW + 20_000).crossesThreshold).toBe(false)

    expect(recordForReason('launch-failed', NOW + 25_000).crashesInWindow).toBe(0)

    expect(readGpuCrashHistory(userDataPath, environment)).toEqual([NOW, NOW + 20_000])
    expect(recordForReason('crashed', NOW + 41_000).crossesThreshold).toBe(true)
  })

  it('round-trips the persisted times', () => {
    record(NOW)
    record(NOW + 1_000)
    expect(readGpuCrashHistory(userDataPath, environment)).toEqual([NOW, NOW + 1_000])
    expect(gpuCrashHistoryFileExists(userDataPath)).toBe(true)
  })

  it('leaves no temp file behind', () => {
    record(NOW)
    record(NOW + 1)
    expect(readdirSync(userDataPath).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('discards history from a different app build', () => {
    record(NOW)
    record(NOW + 1_000)

    const upgraded = { ...environment, appVersion: '1.4.164' }
    expect(readGpuCrashHistory(userDataPath, upgraded)).toEqual([])
    // A new build gets one clean slate, the same policy the marker uses.
    expect(record(NOW + 2_000, upgraded).crashesInWindow).toBe(1)
  })

  it('discards history from a different Electron build', () => {
    record(NOW)
    expect(
      readGpuCrashHistory(userDataPath, { ...environment, electronVersion: '43.0.0' })
    ).toEqual([])
  })

  it('discards a corrupt or wrong-version file instead of trusting it', () => {
    writeFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), '{ not json')
    expect(readGpuCrashHistory(userDataPath, environment)).toEqual([])
    // Why removed rather than left for the next write: a file nothing can read still
    // arms the startup temp sweep on every launch it survives.
    expect(gpuCrashHistoryFileExists(userDataPath)).toBe(false)

    writeFileSync(
      join(userDataPath, GPU_CRASH_HISTORY_FILE),
      JSON.stringify({ schemeVersion: 999, crashTimes: [NOW, NOW, NOW], ...environment })
    )
    expect(readGpuCrashHistory(userDataPath, environment)).toEqual([])
    expect(record(NOW).crossesThreshold).toBe(false)
  })

  it('ignores a crashTimes value that is not an array', () => {
    writeFileSync(
      join(userDataPath, GPU_CRASH_HISTORY_FILE),
      JSON.stringify({ schemeVersion: 1, crashTimes: 'lots', ...environment })
    )
    expect(readGpuCrashHistory(userDataPath, environment)).toEqual([])
  })

  it('does not latch after the wall clock steps backwards', () => {
    // Two real crashes, then the clock rewinds 5 hours (dual-boot RTC skew). The
    // stored entries are now future-dated; a rolling window never prunes that end,
    // so without the future check they would sit there and the next crash would be
    // the "third" — safe graphics latched with no burst and no consent.
    record(NOW)
    record(NOW + 20_000)
    expect(readGpuCrashHistory(userDataPath, environment)).toHaveLength(2)

    const rewound = NOW - 5 * 3_600_000
    const afterJump = record(rewound)

    expect(afterJump.crossesThreshold).toBe(false)
    expect(afterJump.crashesInWindow).toBe(1)
    expect(readGpuCrashHistory(userDataPath, environment)).toEqual([rewound])
  })

  it('does not fire on a stale count from hours earlier', () => {
    record(NOW)
    record(NOW + 1_000)
    expect(record(NOW + 4 * 3_600_000).crossesThreshold).toBe(false)
  })

  it('caps the persisted array', () => {
    for (let index = 0; index < MAX_GPU_CRASH_HISTORY_ENTRIES + 20; index += 1) {
      record(NOW + index)
    }
    expect(readGpuCrashHistory(userDataPath, environment)).toHaveLength(
      MAX_GPU_CRASH_HISTORY_ENTRIES
    )
  })

  it('clears the history so an engaged fallback cannot immediately re-fire', () => {
    record(NOW)
    record(NOW + 1_000)
    clearGpuCrashHistory(userDataPath)

    expect(gpuCrashHistoryFileExists(userDataPath)).toBe(false)
    expect(record(NOW + 2_000).crossesThreshold).toBe(false)
  })

  it('clearing a history that is already gone is not an error', () => {
    expect(() => clearGpuCrashHistory(userDataPath)).not.toThrow()
  })

  it('hands out a fresh inert decision rather than one shared mutable array', () => {
    const first = inertGpuCrashHistoryDecision()
    first.crashTimes.push(NOW)
    expect(inertGpuCrashHistoryDecision()).toEqual({
      crashTimes: [],
      crashesInWindow: 0,
      crossesThreshold: false
    })
  })

  it('never throws when the file cannot be written', () => {
    // A directory at the target path fails both the durable and the direct write.
    mkdirSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))

    // Why: this runs on the path racing Chromium's kill, so a throw here would
    // take out the marker write that is the actual remedy.
    expect(() => record(NOW)).not.toThrow()
    expect(readdirSync(userDataPath).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('sweeps temp files orphaned by a kill between write and rename', async () => {
    record(NOW)
    const orphan = join(userDataPath, `${GPU_CRASH_HISTORY_FILE}.999999.123.abc.tmp`)
    writeFileSync(orphan, '{}')

    await sweepStaleGpuCrashHistoryTempFiles(userDataPath)

    expect(existsSync(orphan)).toBe(false)
    // The history itself shares the prefix and must survive the sweep.
    expect(readGpuCrashHistory(userDataPath, environment)).toEqual([NOW])
  })

  // Why this exists at all: 66 of the 73 observed launches record one or two GPU
  // deaths and never reach three, and no other caller deletes the file on that path —
  // it would sit there arming the startup temp sweep for the life of the install.
  describe('discardExpiredGpuCrashHistory', () => {
    const discard = (now: number, env: GpuFallbackEnvironment = environment) =>
      discardExpiredGpuCrashHistory(userDataPath, env, { now, windowMs: WINDOW })

    afterEach(() => {
      removalFailure.error = null
    })

    it('deletes a history whose entries have all aged out', async () => {
      record(NOW)
      record(NOW + 1_000)

      await discard(NOW + WINDOW + 61_000)

      expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
    })

    it('leaves the next launch with nothing to arm the temp sweep', async () => {
      record(NOW)
      // The exact gate maybeApplyGpuFallbackForThisLaunch reads to fire the readdirs.
      expect(gpuCrashHistoryFileExists(userDataPath)).toBe(true)

      await discard(NOW + WINDOW + 61_000)

      expect(gpuCrashHistoryFileExists(userDataPath)).toBe(false)
      expect(record(NOW + WINDOW + 62_000).crashesInWindow).toBe(1)
    })

    it('keeps a history that still holds a crash inside the window', async () => {
      record(NOW)
      record(NOW + WINDOW - 1_000)

      // One entry has aged out and one has not. Deleting here would throw away the
      // live count that the next crash needs to reach the threshold.
      await discard(NOW + WINDOW + 1)

      expect(readGpuCrashHistory(userDataPath, environment)).toEqual([NOW, NOW + WINDOW - 1_000])
      expect(gpuCrashHistoryFileExists(userDataPath)).toBe(true)
    })

    it('does not throw when the unlink is refused', async () => {
      for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
        record(NOW)
        removalFailure.error = Object.assign(new Error(`${code}: refused`), { code })

        // Why asserted: this runs on the pre-whenReady startup path, where a rejection
        // would surface as an unhandled one before any window exists to report it.
        await expect(discard(NOW + WINDOW + 61_000)).resolves.toBeUndefined()

        // The count is untouched, so the whole cost is one more armed sweep.
        expect([code, gpuCrashHistoryFileExists(userDataPath)]).toEqual([code, true])
        removalFailure.error = null
      }
    })

    it('does nothing when there is no history to discard', async () => {
      await expect(discard(NOW)).resolves.toBeUndefined()
      expect(readdirSync(userDataPath)).toEqual([])
    })

    it('deletes a corrupt file instead of leaving it to arm the sweep', async () => {
      writeFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), '{ not json')

      await discard(NOW)

      expect(gpuCrashHistoryFileExists(userDataPath)).toBe(false)
    })

    it('deletes another build history even while its entries are live', async () => {
      record(NOW)

      await discard(NOW, { ...environment, appVersion: '1.4.164' })

      // This build can never count them, so keeping them only arms the sweep.
      expect(gpuCrashHistoryFileExists(userDataPath)).toBe(false)
    })

    for (const platform of ['darwin', 'linux'] as const) {
      it(`deletes a live history that followed a profile onto ${platform}`, async () => {
        record(NOW)

        await discard(NOW, { ...environment, platform })

        expect(gpuCrashHistoryFileExists(userDataPath)).toBe(false)
      })
    }
  })

  for (const platform of ['darwin', 'linux'] as const) {
    it(`writes nothing and never fires on ${platform}`, () => {
      const foreign = { ...environment, platform }

      for (let index = 0; index < 10; index += 1) {
        expect(record(NOW + index * 1_000, foreign)).toEqual({
          crashTimes: [],
          crashesInWindow: 0,
          crossesThreshold: false
        })
      }

      expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
      expect(readdirSync(userDataPath)).toEqual([])
    })

    it(`discards a history file that followed a profile onto ${platform}`, () => {
      record(NOW)
      record(NOW + 1_000)
      const persisted = readFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), 'utf-8')
      expect(persisted).toContain('win32')

      expect(readGpuCrashHistory(userDataPath, { ...environment, platform })).toEqual([])
      expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
    })
  }
})
