import { describe, expect, it, vi } from 'vitest'
import { withPlatform } from '../window/createMainWindow-test-harness'
import {
  createLowCommitOomRecoveryGate,
  LOW_COMMIT_REPEAT_OOM_WINDOW_MS,
  type LowCommitOomVerdict
} from './low-commit-oom-recovery-gate'

const OOM: Electron.RenderProcessGoneDetails = { reason: 'oom', exitCode: -536870904 }
const CRASHED: Electron.RenderProcessGoneDetails = { reason: 'crashed', exitCode: 5 }
// Launch 22912 (Scan-30 1790622432/1790622459): OOM at 19:06:54.6, reload OOMed again at 19:07:28.7.
const FIRST_OOM = Date.parse('2026-09-28T19:06:54.600Z')
const RELOAD_OOM = Date.parse('2026-09-28T19:07:28.700Z')

function sample(swapFreeMB: number | undefined, ageMs = 4_000) {
  return () => ({
    systemMemoryPreGoneSampleAgeMs: ageMs,
    ...(swapFreeMB === undefined ? {} : { systemMemoryPreGoneSwapFreeMB: swapFreeMB })
  })
}

// A gone-time read that resolved no commit field, as off-Electron.
const NO_GONE_TIME_READING = () => ({})

function goneTime(swapFreeMB: number) {
  return () => ({ systemMemorySwapFreeMB: swapFreeMB })
}

function observeTwice(
  read: ReturnType<typeof sample>,
  second = OOM,
  gapMs = RELOAD_OOM - FIRST_OOM,
  platform: NodeJS.Platform = 'win32',
  readGoneTime: () => Record<string, number> = NO_GONE_TIME_READING
) {
  return withPlatform(platform, () => {
    const gate = createLowCommitOomRecoveryGate(read, readGoneTime)
    const first = gate.assess(OOM, FIRST_OOM)
    gate.recordRecoveredDeath(OOM, FIRST_OOM)
    return [first, gate.assess(second, FIRST_OOM + gapMs)]
  })
}

describe('createLowCommitOomRecoveryGate', () => {
  it('holds the reload of a repeat OOM with 60 MB of commit left', () => {
    expect(observeTwice(sample(60))).toEqual([
      null,
      { availableCommitMB: 60, sincePreviousOomMs: 34_100, commitReading: 'pre-gone' }
    ])
  })

  it('always lets the first OOM of the launch auto-reload, even with 5 MB left', () => {
    expect(observeTwice(sample(5))[0]).toBeNull()
  })

  it.each([
    ['commit is healthy (744 MB)', sample(744), OOM, 34_100, 'win32'],
    [
      'the previous OOM was over 5 minutes ago',
      sample(60),
      OOM,
      LOW_COMMIT_REPEAT_OOM_WINDOW_MS + 1,
      'win32'
    ],
    ['the death is not an OOM', sample(60), CRASHED, 34_100, 'win32'],
    ['no commit reading exists', sample(undefined), OOM, 34_100, 'win32'],
    ['the reading is stale', sample(60, 31_000), OOM, 34_100, 'win32'],
    ['the host is macOS', sample(60), OOM, 34_100, 'darwin'],
    ['the host is Linux', sample(60), OOM, 34_100, 'linux']
  ] as const)('reloads when %s', (_label, read, second, gapMs, platform) => {
    expect(observeTwice(read, second, gapMs, platform)[1]).toBeNull()
  })

  // Launch 13084 (Scan-31): 12:20:37.207 then 12:22:59.975; each OOM restarts the window.
  it('measures the window from the most recent OOM', () => {
    const verdicts = withPlatform('win32', () => {
      const gate = createLowCommitOomRecoveryGate(sample(60, 2_000), NO_GONE_TIME_READING)
      return [
        '2026-09-29T12:06:19.869Z',
        '2026-09-29T12:20:37.207Z',
        '2026-09-29T12:20:40.665Z',
        '2026-09-29T12:22:59.975Z'
      ].map((iso) => {
        const verdict = gate.assess(OOM, Date.parse(iso))
        gate.recordRecoveredDeath(OOM, Date.parse(iso))
        return verdict
      })
    })
    expect(verdicts.map((v) => v?.sincePreviousOomMs ?? null)).toEqual([null, null, 3_458, 139_310])
  })

  // Launch 13084: the repeat OOM came 3.458 s after the previous one, inside one 10 s sampler tick.
  describe('when no sampler tick landed since the previous OOM', () => {
    const gapMs = 3_458

    it.each([
      ['taken before the previous OOM', 5_000],
      ['taken exactly at the previous OOM', gapMs],
      ['stale', 31_000]
    ])('reads commit at gone time instead of trusting a reading %s', (_label, ageMs) => {
      expect(observeTwice(sample(744, ageMs), OOM, gapMs, 'win32', goneTime(60))[1]).toEqual({
        availableCommitMB: 60,
        sincePreviousOomMs: gapMs,
        commitReading: 'gone-time'
      })
    })

    it('reloads when the gone-time reading shows commit recovered (2029 MB)', () => {
      expect(observeTwice(sample(60, 5_000), OOM, gapMs, 'win32', goneTime(2_029))[1]).toBeNull()
    })

    it('prefers a reading taken after the previous OOM over the gone-time one', () => {
      expect(observeTwice(sample(60, 1_000), OOM, gapMs, 'win32', goneTime(2_029))[1]).toEqual({
        availableCommitMB: 60,
        sincePreviousOomMs: gapMs,
        commitReading: 'pre-gone'
      })
    })

    it('reads nothing on macOS or Linux', () => {
      const readGoneTime = vi.fn(goneTime(60))
      for (const platform of ['darwin', 'linux'] as const) {
        expect(observeTwice(sample(60, 5_000), OOM, gapMs, platform, readGoneTime)[1]).toBeNull()
      }
      expect(readGoneTime).not.toHaveBeenCalled()
    })
  })

  describe('when both a fresh pre-gone and a gone-time reading exist', () => {
    type Oom = { at: string; preGoneMB: number; ageMs: number; goneTimeMB: number }

    // Replays each OOM until the first prompt, recovering only the deaths that auto-reloaded.
    function replay(ooms: Oom[]) {
      return withPlatform('win32', () => {
        let current = ooms[0]
        const gate = createLowCommitOomRecoveryGate(
          () => ({
            systemMemoryPreGoneSwapFreeMB: current.preGoneMB,
            systemMemoryPreGoneSampleAgeMs: current.ageMs
          }),
          () => ({ systemMemorySwapFreeMB: current.goneTimeMB })
        )
        const verdicts: (LowCommitOomVerdict | null)[] = []
        for (const oom of ooms) {
          current = oom
          const verdict = gate.assess(OOM, Date.parse(oom.at))
          verdicts.push(verdict)
          if (verdict) {
            break
          }
          gate.recordRecoveredDeath(OOM, Date.parse(oom.at))
        }
        return verdicts
      })
    }

    // Scan-36 r07: commit fell from 515 MB at the last tick to 195 MB at gone time, then reloaded into another OOM.
    it('holds the reload on the lower gone-time reading', () => {
      expect(
        replay([
          { at: '2026-10-02T07:50:56.618Z', preGoneMB: 3_570, ageMs: 768, goneTimeMB: 4_256 },
          { at: '2026-10-02T07:56:33.770Z', preGoneMB: 722, ageMs: 7_714, goneTimeMB: 48 },
          { at: '2026-10-02T07:56:39.018Z', preGoneMB: 515, ageMs: 2_961, goneTimeMB: 195 }
        ])
      ).toEqual([
        null,
        null,
        { availableCommitMB: 195, sincePreviousOomMs: 5_248, commitReading: 'gone-time' }
      ])
    })

    // Scan-36 r13: the pre-gone reading is the lower one, so it still prompts on the second OOM.
    it('holds the reload on the lower pre-gone reading', () => {
      expect(
        replay([
          { at: '2026-10-02T10:03:54.638Z', preGoneMB: 246, ageMs: 5_516, goneTimeMB: 417 },
          { at: '2026-10-02T10:04:00.387Z', preGoneMB: 5, ageMs: 1_261, goneTimeMB: 270 },
          { at: '2026-10-02T10:04:07.882Z', preGoneMB: 5, ageMs: 8_755, goneTimeMB: 362 }
        ])
      ).toEqual([
        null,
        { availableCommitMB: 5, sincePreviousOomMs: 5_749, commitReading: 'pre-gone' }
      ])
    })

    it.each([Number.NaN, -1])('ignores an invalid gone-time reading (%s)', (goneTimeMB) => {
      expect(observeTwice(sample(60, 1_000), OOM, 3_458, 'win32', goneTime(goneTimeMB))[1]).toEqual(
        { availableCommitMB: 60, sincePreviousOomMs: 3_458, commitReading: 'pre-gone' }
      )
    })
  })

  it.each([Number.NaN, Infinity, -1])(
    'does not block recovery on an invalid commit reading (%s)',
    (commitMB) => {
      expect(observeTwice(sample(commitMB), OOM, 34_100, 'win32', goneTime(commitMB))[1]).toBeNull()
    }
  )

  it.each([Number.NaN, Infinity, -1])('ignores an invalid sample age (%s)', (ageMs) => {
    expect(observeTwice(sample(60, ageMs), OOM, 34_100, 'win32', goneTime(2_029))[1]).toBeNull()
  })

  it.each([0, -1])('does not block recovery when the clock fails to advance (%s)', (gapMs) => {
    expect(observeTwice(sample(60), OOM, gapMs, 'win32', goneTime(60))[1]).toBeNull()
  })

  it('does not start the repeat window for an OOM that was never recovered', () => {
    const verdict = withPlatform('win32', () => {
      const gate = createLowCommitOomRecoveryGate(sample(60, 2_000), NO_GONE_TIME_READING)
      gate.assess(OOM, FIRST_OOM)
      return gate.assess(OOM, RELOAD_OOM)
    })
    expect(verdict).toBeNull()
  })
})

// Scan-37 r29 (launch e0a3d440): SkBitmap tryAllocPixels CHECK, then the reload died of 0xC00000FD 2.9 s later.
describe('when commit exhaustion surfaces as a renderer crash', () => {
  const ALLOC_CHECK: Electron.RenderProcessGoneDetails = {
    reason: 'crashed',
    exitCode: -2147483645
  }
  const STACK_OVERFLOW: Electron.RenderProcessGoneDetails = {
    reason: 'crashed',
    exitCode: -1073741571
  }
  const CHECK_AT = Date.parse('2026-10-03T11:29:51.755Z')
  const OVERFLOW_AT = Date.parse('2026-10-03T11:29:54.641Z')
  type Death = {
    details: Electron.RenderProcessGoneDetails
    at: number
    preGoneMB: number
    ageMs: number
    goneTimeMB: number
  }
  const R29: Death[] = [
    { details: ALLOC_CHECK, at: CHECK_AT, preGoneMB: 9, ageMs: 1_384, goneTimeMB: 11 },
    { details: STACK_OVERFLOW, at: OVERFLOW_AT, preGoneMB: 9, ageMs: 4_271, goneTimeMB: 431 }
  ]

  // Recovers every death; `allocationChecks` are the gone times whose dump named an allocation CHECK.
  function replay(
    deaths: Death[],
    allocationChecks: number[] = [CHECK_AT],
    platform: NodeJS.Platform = 'win32'
  ) {
    return withPlatform(platform, () => {
      let current = deaths[0]
      const gate = createLowCommitOomRecoveryGate(
        () => ({
          systemMemoryPreGoneSwapFreeMB: current.preGoneMB,
          systemMemoryPreGoneSampleAgeMs: current.ageMs
        }),
        () => ({ systemMemorySwapFreeMB: current.goneTimeMB }),
        (goneAt) => allocationChecks.includes(goneAt)
      )
      return deaths.map((death) => {
        current = death
        const verdict = gate.assess(death.details, death.at)
        gate.recordRecoveredDeath(death.details, death.at)
        return verdict && gate.confirmsHold(death.details, death.at) ? verdict : null
      })
    })
  }

  it('holds the reload after an allocation CHECK on a starved host', () => {
    expect(replay(R29)).toEqual([
      null,
      { availableCommitMB: 431, sincePreviousOomMs: 2_886, commitReading: 'gone-time' }
    ])
  })

  it('holds the reload of a repeat allocation CHECK whose dump landed before recovery', () => {
    const second = { ...R29[0], at: OVERFLOW_AT, ageMs: 1_000 }
    expect(replay([R29[0], second], [CHECK_AT, OVERFLOW_AT])[1]).toEqual({
      availableCommitMB: 9,
      sincePreviousOomMs: 2_886,
      commitReading: 'pre-gone'
    })
  })

  it('reloads a repeat CHECK whose dump never named an allocation failure', () => {
    const second = { ...R29[0], at: OVERFLOW_AT, ageMs: 1_000 }
    expect(replay([R29[0], second])[1]).toBeNull()
  })

  it('reloads when the CHECK is not an allocation failure', () => {
    expect(replay(R29, [])[1]).toBeNull()
  })

  it('reloads when the first crash left commit healthy', () => {
    expect(replay([{ ...R29[0], preGoneMB: 4_000, goneTimeMB: 4_000 }, R29[1]])[1]).toBeNull()
  })

  it('reloads when commit recovered by the repeat crash', () => {
    expect(replay([R29[0], { ...R29[1], preGoneMB: 2_000, goneTimeMB: 2_000 }])[1]).toBeNull()
  })

  it('reloads an ordinary crash on a starved host', () => {
    const ordinary = { ...R29[1], details: { reason: 'crashed', exitCode: 5 } as const }
    expect(replay([R29[0], ordinary])[1]).toBeNull()
    expect(replay([{ ...R29[0], details: ordinary.details }, R29[1]])[1]).toBeNull()
  })

  it('does not let an unconfirmed CHECK hide the OOM before it', () => {
    const oom = { ...R29[0], details: OOM, at: CHECK_AT - 2_000 }
    expect(replay([oom, R29[0], R29[1]], [])[2]).toEqual({
      availableCommitMB: 431,
      sincePreviousOomMs: 4_886,
      commitReading: 'gone-time'
    })
  })

  it('reloads on macOS', () => {
    expect(replay(R29, [CHECK_AT], 'darwin')[1]).toBeNull()
  })
})
