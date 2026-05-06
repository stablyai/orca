/* eslint-disable max-lines */
// End-to-end behavior of the track() wrapper against a mock PostHog. These
// tests pin the ordering contracts:
//
//   - shutdown gate fires before anything else
//   - burst cap runs BEFORE consent resolve (opted-out flood does not hit
//     resolveConsent)
//   - per-session 1000-event ceiling enforced
//   - opt-out event reaches the SDK queue BEFORE posthog.optOut() — the one
//     event that transmits against the user's new preference
//   - serialized capture payload is exactly CommonProps ∪ EventProps ∪ the
//     allowed auto-properties ({ $process_person_profile }); an unexpected
//     auto-property from a future SDK upgrade fails the drift check
//
// Tests inject a fake PostHog and a fake Store. No network, no real SDK.

import type { PostHog } from 'posthog-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommonProps } from '../../shared/telemetry-events'
import type { GlobalSettings } from '../../shared/types'
import type { Store } from '../persistence'
import { resetBurstCapsForSession } from './burst-cap'
import {
  _enableTransportForTests,
  _setCommonPropsForTests,
  _setPostHogClientForTests,
  _setShuttingDownForTests,
  _setStoreForTests,
  _resetFirstAppOpenedFiredForTests,
  persistBannerAcknowledgeWithoutEmitting,
  setOptIn,
  shouldOptOutSdkAtInit,
  shutdownTelemetry,
  track,
  trackAppOpenedOnce
} from './client'

// Minimal mock of the PostHog client surface the wrapper actually calls.
// Deliberately narrow — if the client wrapper ever starts calling something
// else (identify, alias, groupIdentify, etc.) we want the type mismatch to
// force review against the no-identify invariant.
type MockPostHog = {
  capture: ReturnType<typeof vi.fn>
  optIn: ReturnType<typeof vi.fn>
  optOut: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emitForTests: (event: string, payload: unknown) => void
}

function makeMockPostHog(): MockPostHog {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emitForTests = (event: string, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload)
    }
  }

  return {
    capture: vi.fn((message: { event?: string; uuid?: string }) => {
      queueMicrotask(() => {
        emitForTests('capture', {
          event: message.event,
          uuid: message.uuid
        })
      })
    }),
    optIn: vi.fn(async () => {}),
    optOut: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      let eventListeners = listeners.get(event)
      if (!eventListeners) {
        eventListeners = new Set()
        listeners.set(event, eventListeners)
      }
      eventListeners.add(listener)
      return () => {
        eventListeners?.delete(listener)
      }
    }),
    emitForTests
  }
}

function makeFakeSettings(telemetry: GlobalSettings['telemetry']): GlobalSettings {
  return { telemetry } as unknown as GlobalSettings
}

function makeFakeStore(settings: GlobalSettings): Store {
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      if (updates.telemetry) {
        settings.telemetry = {
          ...settings.telemetry,
          ...updates.telemetry
        } as typeof settings.telemetry
      }
      return settings
    })
  } as unknown as Store
}

// Env vars read by `resolveConsent` (see `consent.ts`). Any of these set at
// test time — most commonly `CI=true` on GitHub Actions — would make every
// `track()` call drop at the consent gate and every capture assertion fail.
// We clear them per-test and restore in afterEach so tests behave identically
// on a dev laptop (where none are set) and in CI (where `CI` always is).
const CONSENT_ENV_VARS = [
  'DO_NOT_TRACK',
  'ORCA_TELEMETRY_DISABLED',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
] as const

function stashAndClearConsentEnv(): Record<string, string | undefined> {
  const stash: Record<string, string | undefined> = {}
  for (const name of CONSENT_ENV_VARS) {
    stash[name] = process.env[name]
    delete process.env[name]
  }
  return stash
}

function restoreConsentEnv(stash: Record<string, string | undefined>): void {
  for (const name of CONSENT_ENV_VARS) {
    const prior = stash[name]
    if (prior === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = prior
    }
  }
}

const BASE_COMMON: CommonProps = {
  app_version: '1.3.33',
  platform: 'darwin',
  arch: 'arm64',
  os_release: '25.3.0',
  install_id: '00000000-0000-4000-8000-000000000000',
  session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  orca_channel: 'stable'
}

describe('track()', () => {
  let mock: MockPostHog
  let store: Store
  let envStash: Record<string, string | undefined>

  beforeEach(() => {
    envStash = stashAndClearConsentEnv()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetBurstCapsForSession()
    mock = makeMockPostHog()
    store = makeFakeStore(
      makeFakeSettings({
        optedIn: true,
        installId: BASE_COMMON.install_id,
        existedBeforeTelemetryRelease: false
      })
    )
    _setPostHogClientForTests(mock as unknown as PostHog)
    _setCommonPropsForTests(BASE_COMMON)
    _setStoreForTests(store)
    _setShuttingDownForTests(false)
    _enableTransportForTests(true)
    _resetFirstAppOpenedFiredForTests()
  })
  afterEach(() => {
    _enableTransportForTests(false)
    _setPostHogClientForTests(null)
    _setCommonPropsForTests(null)
    _setStoreForTests(null)
    _resetFirstAppOpenedFiredForTests()
    vi.restoreAllMocks()
    restoreConsentEnv(envStash)
  })

  it('captures a valid event with merged common + event props and $process_person_profile false', () => {
    track('app_opened', {})
    expect(mock.capture).toHaveBeenCalledTimes(1)
    const call = mock.capture.mock.calls[0]![0]
    expect(call.event).toBe('app_opened')
    expect(call.distinctId).toBe(BASE_COMMON.install_id)
    expect(call.properties.$process_person_profile).toBe(false)
    for (const key of Object.keys(BASE_COMMON) as (keyof CommonProps)[]) {
      expect(call.properties[key]).toBe(BASE_COMMON[key])
    }
  })

  // Drift-check: the full set of keys on the capture payload is bounded by
  // CommonProps ∪ EventProps ∪ {$process_person_profile}. A future
  // posthog-node upgrade that adds a new auto-property (e.g. $session_id)
  // via our `properties` would widen this — we'd want to review before
  // shipping, so this test fails loudly.
  it('serialized property set is exactly CommonProps ∪ EventProps ∪ {$process_person_profile}', () => {
    track('workspace_created', { source: 'command_palette', from_existing_branch: true })
    const call = mock.capture.mock.calls[0]![0]
    const allowed = new Set([
      ...Object.keys(BASE_COMMON),
      'source',
      'from_existing_branch',
      '$process_person_profile'
    ])
    for (const key of Object.keys(call.properties)) {
      expect(allowed.has(key)).toBe(true)
    }
  })

  it('respects the shutdown gate', () => {
    _setShuttingDownForTests(true)
    track('app_opened', {})
    expect(mock.capture).not.toHaveBeenCalled()
  })

  // Core security-ordering invariant: a compromised renderer of an
  // opted-out user should not be able to burn consent-resolve CPU. The
  // observable signal is `store.getSettings()` — `resolveConsent` calls it
  // exactly once per evaluation, so the call count on the spy is a proxy
  // for "how many events reached the consent gate."
  it('burst cap runs BEFORE consent resolve', () => {
    // Flip the fake store to opted-out. Any track that reaches the consent
    // gate also reads settings via `store.getSettings()` — so the
    // getSettings call count is our observable.
    ;(store.getSettings as ReturnType<typeof vi.fn>).mockReturnValue(
      makeFakeSettings({
        optedIn: false,
        installId: BASE_COMMON.install_id,
        existedBeforeTelemetryRelease: false
      })
    )
    // Exhaust the per-event bucket (30 default).
    for (let i = 0; i < 30; i++) {
      track('app_opened', {})
    }
    const callsAtBoundary = (store.getSettings as ReturnType<typeof vi.fn>).mock.calls.length
    // Further calls must short-circuit in the burst cap — consent is never
    // reached for the post-cap flood, so getSettings is not called again.
    for (let i = 0; i < 20; i++) {
      track('app_opened', {})
    }
    expect((store.getSettings as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtBoundary)
    expect(mock.capture).not.toHaveBeenCalled()
  })

  it('enforces per-event burst cap (30 per minute default)', () => {
    for (let i = 0; i < 50; i++) {
      track('app_opened', {})
    }
    expect(mock.capture).toHaveBeenCalledTimes(30)
  })

  it('enforces the per-session 1000-event global ceiling across event names', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'))
    // Advance time between calls so the per-event token buckets refill —
    // the only remaining cap is the session ceiling.
    for (let i = 0; i < 1500; i++) {
      vi.advanceTimersByTime(10_000)
      track('app_opened', {})
    }
    expect(mock.capture).toHaveBeenCalledTimes(1000)
    vi.useRealTimers()
  })

  it('drops invalid events before calling capture', () => {
    // Raw error strings on agent_error are rejected by `.strict()`.
    track('agent_error', {
      error_class: 'unknown',
      agent_kind: 'claude-code',
      error_message: 'leaked message' // rejected by .strict()
    } as never)
    expect(mock.capture).not.toHaveBeenCalled()
  })

  it('trackAppOpenedOnce emits app_opened at most once per session', () => {
    trackAppOpenedOnce()
    trackAppOpenedOnce()
    expect(mock.capture).toHaveBeenCalledTimes(1)
    expect(mock.capture.mock.calls[0]![0].event).toBe('app_opened')
  })
})

describe('setOptIn()', () => {
  let mock: MockPostHog
  let store: Store
  let settings: GlobalSettings
  let envStash: Record<string, string | undefined>

  beforeEach(() => {
    envStash = stashAndClearConsentEnv()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetBurstCapsForSession()
    mock = makeMockPostHog()
    settings = makeFakeSettings({
      optedIn: true,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: false
    })
    store = makeFakeStore(settings)
    _setPostHogClientForTests(mock as unknown as PostHog)
    _setCommonPropsForTests(BASE_COMMON)
    _setStoreForTests(store)
    _setShuttingDownForTests(false)
    _enableTransportForTests(true)
    _resetFirstAppOpenedFiredForTests()
  })
  afterEach(() => {
    _enableTransportForTests(false)
    _setPostHogClientForTests(null)
    _setCommonPropsForTests(null)
    _setStoreForTests(null)
    _resetFirstAppOpenedFiredForTests()
    vi.restoreAllMocks()
    restoreConsentEnv(envStash)
  })

  // Ordering invariant: the opt-out event is the one signal that transmits
  // against the user's new preference. It MUST reach the SDK queue before
  // we disable the SDK — otherwise posthog-node drops it at enqueue time.
  it('waits for telemetry_opted_out to enqueue before posthog.optOut()', async () => {
    const order: string[] = []
    mock.capture.mockImplementation((message: { event?: string; uuid?: string }) => {
      order.push('capture called')
      queueMicrotask(() => {
        order.push('sdk enqueue')
        mock.emitForTests('capture', {
          event: message.event,
          uuid: message.uuid
        })
      })
    })
    mock.optOut.mockImplementation(async () => {
      order.push('optOut')
    })
    await setOptIn('settings', false)
    expect(order).toEqual(['capture called', 'sdk enqueue', 'optOut'])
  })

  it('fires telemetry_opted_in after posthog.optIn without app_opened for settings opt-in', async () => {
    // Flip settings to currently-opted-out so the flip to true exercises
    // the opt-in branch cleanly. This is not the pending-banner path, so
    // it must not replay the once-per-session app_opened event.
    settings.telemetry!.optedIn = false
    const order: string[] = []
    mock.optIn.mockImplementation(async () => order.push('optIn'))
    mock.capture.mockImplementation((message: { event?: string }) => {
      order.push(`capture:${message.event}`)
    })
    await setOptIn('settings', true)
    expect(order).toEqual(['optIn', 'capture:telemetry_opted_in'])
  })

  it('drops telemetry_opted_in silently in non-official builds', async () => {
    settings.telemetry!.optedIn = false
    _setPostHogClientForTests(null)
    _enableTransportForTests(false)

    await setOptIn('settings', true)

    expect(mock.capture).not.toHaveBeenCalled()
    expect(console.debug).not.toHaveBeenCalled()
  })

  it('fires app_opened once after pending-banner opt-in enables the SDK', async () => {
    settings.telemetry = {
      optedIn: null,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: true
    }
    const order: string[] = []
    mock.optIn.mockImplementation(async () => order.push('optIn'))
    mock.capture.mockImplementation((message: { event?: string }) => {
      order.push(`capture:${message.event}`)
    })

    await setOptIn('settings', true)

    expect(order).toEqual(['optIn', 'capture:app_opened', 'capture:telemetry_opted_in'])
  })
})

describe('persistBannerAcknowledgeWithoutEmitting()', () => {
  let mock: MockPostHog
  let store: Store
  let settings: GlobalSettings
  let envStash: Record<string, string | undefined>

  beforeEach(() => {
    envStash = stashAndClearConsentEnv()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetBurstCapsForSession()
    mock = makeMockPostHog()
    settings = makeFakeSettings({
      optedIn: null,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: true
    })
    store = makeFakeStore(settings)
    _setPostHogClientForTests(mock as unknown as PostHog)
    _setCommonPropsForTests(BASE_COMMON)
    _setStoreForTests(store)
    _setShuttingDownForTests(false)
    _enableTransportForTests(true)
    _resetFirstAppOpenedFiredForTests()
  })

  afterEach(() => {
    _enableTransportForTests(false)
    _setPostHogClientForTests(null)
    _setCommonPropsForTests(null)
    _setStoreForTests(null)
    _resetFirstAppOpenedFiredForTests()
    vi.restoreAllMocks()
    restoreConsentEnv(envStash)
  })

  it('fires app_opened after re-enabling the SDK and does not emit telemetry_opted_in', async () => {
    const order: string[] = []
    mock.optIn.mockImplementation(async () => order.push('optIn'))
    mock.capture.mockImplementation((message: { event?: string }) => {
      order.push(`capture:${message.event}`)
    })

    await persistBannerAcknowledgeWithoutEmitting()

    expect(order).toEqual(['optIn', 'capture:app_opened'])
    expect(settings.telemetry?.optedIn).toBe(true)
  })
})

// Pin the init-time SDK opt-out decision. The bug this test prevents: if
// `initTelemetry` flipped the SDK's `optedOut` flag for `pending_banner`
// (existing users who have not yet resolved the notice), the direct
// `posthog.capture(telemetry_opted_out)` on the Turn-off path would be
// dropped by posthog-core's enqueue — silently losing the one signal that
// tells us the existing-user opt-out flow works.
describe('shouldOptOutSdkAtInit()', () => {
  it('opts out the SDK for every disabled-reason', () => {
    for (const reason of ['user_opt_out', 'ci', 'do_not_track', 'orca_disabled'] as const) {
      expect(shouldOptOutSdkAtInit({ effective: 'disabled', reason })).toBe(true)
    }
  })

  it('does NOT opt out the SDK for pending_banner', () => {
    expect(shouldOptOutSdkAtInit({ effective: 'pending_banner' })).toBe(false)
  })

  it('does NOT opt out the SDK for enabled', () => {
    expect(shouldOptOutSdkAtInit({ effective: 'enabled' })).toBe(false)
  })
})

describe('shutdownTelemetry()', () => {
  // Reset module-level state that persists across tests: shutdownTelemetry
  // leaves shuttingDown=true, which would silently drop events in any
  // later-added test. Also null out the client so a stale mock from one
  // test cannot leak into the next.
  afterEach(() => {
    _setShuttingDownForTests(false)
    _setPostHogClientForTests(null)
  })

  it('sets the shutdown gate and calls posthog.shutdown(2000)', async () => {
    const mock = makeMockPostHog()
    _setPostHogClientForTests(mock as unknown as PostHog)
    _setShuttingDownForTests(false)
    await shutdownTelemetry()
    expect(mock.shutdown).toHaveBeenCalledWith(2_000)
    _setPostHogClientForTests(null)
  })

  it('is a no-op when no client is initialized', async () => {
    _setPostHogClientForTests(null)
    await expect(shutdownTelemetry()).resolves.toBeUndefined()
  })
})
