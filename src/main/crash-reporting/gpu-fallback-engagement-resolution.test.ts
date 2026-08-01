import { describe, expect, it } from 'vitest'
import type { GpuFallbackEngagementOutcome } from './gpu-fallback-engagement'
import { resolveGpuFallbackEngagement } from './gpu-fallback-engagement-resolution'

const USER_DATA = '/tmp/orca-userdata'

describe('resolveGpuFallbackEngagement', () => {
  // Why exhaustive: every field here is a one-token change away from defeating the
  // feature silently, and this table is the only thing that can see it.
  const expected: Record<
    GpuFallbackEngagementOutcome,
    {
      provisionalMarkerPath: string | null
      rePersistConsentedMarker: boolean
      clearDurableHistory: boolean
      relaunch: boolean
    }
  > = {
    restart: {
      provisionalMarkerPath: null,
      rePersistConsentedMarker: true,
      clearDurableHistory: true,
      relaunch: true
    },
    'confirmed-quitting': {
      provisionalMarkerPath: null,
      rePersistConsentedMarker: true,
      clearDurableHistory: true,
      relaunch: false
    },
    deferred: {
      provisionalMarkerPath: null,
      rePersistConsentedMarker: false,
      clearDurableHistory: true,
      relaunch: false
    },
    'deferred-uncleared': {
      provisionalMarkerPath: USER_DATA,
      rePersistConsentedMarker: false,
      clearDurableHistory: true,
      relaunch: false
    },
    latched: {
      provisionalMarkerPath: USER_DATA,
      rePersistConsentedMarker: false,
      clearDurableHistory: true,
      relaunch: false
    },
    'marker-failed': {
      provisionalMarkerPath: null,
      rePersistConsentedMarker: false,
      clearDurableHistory: false,
      relaunch: false
    }
  }

  for (const [outcome, resolution] of Object.entries(expected)) {
    it(`resolves ${outcome}`, () => {
      expect(
        resolveGpuFallbackEngagement(outcome as GpuFallbackEngagementOutcome, USER_DATA)
      ).toEqual(resolution)
    })
  }

  it('stands the shutdown drop down for every settled outcome', () => {
    // Why its own assertion: keeping the provisional path on a settled outcome
    // deletes the consented marker on the way out, so the relaunch comes back on
    // the same broken GPU — the exact mutation the source-text tests could not see.
    for (const outcome of ['restart', 'confirmed-quitting', 'deferred', 'marker-failed'] as const) {
      expect([
        outcome,
        resolveGpuFallbackEngagement(outcome, USER_DATA).provisionalMarkerPath
      ]).toEqual([outcome, null])
    }
  })

  it('keeps the shutdown drop armed only while the marker is unconfirmed', () => {
    for (const outcome of ['latched', 'deferred-uncleared'] as const) {
      expect([
        outcome,
        resolveGpuFallbackEngagement(outcome, USER_DATA).provisionalMarkerPath
      ]).toEqual([outcome, USER_DATA])
    }
  })

  it('records consent on both paths where the user actually answered "restart"', () => {
    // 'restart' latched pre-prompt with consented:false, so without the re-persist
    // the primary consent path would land on disk indistinguishable from a latch.
    expect(resolveGpuFallbackEngagement('restart', USER_DATA).rePersistConsentedMarker).toBe(true)
    expect(
      resolveGpuFallbackEngagement('confirmed-quitting', USER_DATA).rePersistConsentedMarker
    ).toBe(true)
    expect(resolveGpuFallbackEngagement('latched', USER_DATA).rePersistConsentedMarker).toBe(false)
    expect(resolveGpuFallbackEngagement('deferred', USER_DATA).rePersistConsentedMarker).toBe(false)
  })

  it('relaunches only on an answered restart that no quit already claimed', () => {
    expect(resolveGpuFallbackEngagement('restart', USER_DATA).relaunch).toBe(true)
    for (const outcome of [
      'confirmed-quitting',
      'deferred',
      'deferred-uncleared',
      'latched',
      'marker-failed'
    ] as const) {
      expect([outcome, resolveGpuFallbackEngagement(outcome, USER_DATA).relaunch]).toEqual([
        outcome,
        false
      ])
    }
  })

  it('drops the cross-launch count once the prompt has been answered', () => {
    // Why: after 'deferred' the app keeps running with gpuFallbackActiveThisLaunch
    // false, so handleGpuChildCrash still runs — but the stored 2 entries would make
    // the next GPU crash inside the 5-minute window the "third" and re-latch on a
    // prompt the user just declined.
    for (const outcome of [
      'restart',
      'confirmed-quitting',
      'deferred',
      'deferred-uncleared',
      'latched'
    ] as const) {
      expect([
        outcome,
        resolveGpuFallbackEngagement(outcome, USER_DATA).clearDurableHistory
      ]).toEqual([outcome, true])
    }
  })

  it('keeps the count armed when the marker write is what failed', () => {
    // 'marker-failed' never prompted, so the crashes are still unaddressed. Clearing
    // would demand three fresh crashes before retrying a transient EPERM.
    expect(resolveGpuFallbackEngagement('marker-failed', USER_DATA).clearDurableHistory).toBe(false)
  })

  it('echoes back the caller path so a split userData cannot go unnoticed', () => {
    expect(resolveGpuFallbackEngagement('latched', '/other/path').provisionalMarkerPath).toBe(
      '/other/path'
    )
  })
})
