// IPC boundary behavior for the telemetry surface. Strict type narrows must
// drop obviously-malformed calls before they reach the validator (the
// renderer is in the threat model). Pins the consent-mutation rate limit:
// ≤5 consent-related IPC calls per session. Pins the main-side `via`
// derivation: both `OptInVia` branches are reachable from renderer input,
// and the one path that must NOT emit (`acknowledgeBanner`) has its own
// channel and handler rather than being a flag on `setOptIn`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import type { Store } from '../persistence'

const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
const {
  handleMock,
  trackMock,
  setOptInMock,
  persistBannerAcknowledgeMock,
  consumeConsentMutationTokenMock,
  getCohortAtEmitMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  trackMock: vi.fn(),
  setOptInMock: vi.fn(),
  persistBannerAcknowledgeMock: vi.fn(),
  consumeConsentMutationTokenMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../telemetry/client', () => ({
  track: trackMock,
  setOptIn: setOptInMock,
  persistBannerAcknowledgeWithoutEmitting: persistBannerAcknowledgeMock
}))
vi.mock('../telemetry/burst-cap', () => ({
  consumeConsentMutationToken: consumeConsentMutationTokenMock
}))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

import { _resetStoreForTests, registerTelemetryHandlers } from './telemetry'

function captureHandlers(): void {
  handlers.clear()
  for (const call of handleMock.mock.calls) {
    const [channel, handler] = call as [
      string,
      typeof handlers extends Map<string, infer V> ? V : never
    ]
    handlers.set(channel, handler)
  }
}

// Build a fake Store with a settable `telemetry` block. Tests reassign
// `settings.telemetry` between handler invocations to seed the two
// derivation states.
type FakeStoreState = { settings: GlobalSettings }
function makeFakeStore(telemetry: GlobalSettings['telemetry']): {
  store: Store
  state: FakeStoreState
} {
  const state: FakeStoreState = { settings: { telemetry } as unknown as GlobalSettings }
  const store = {
    getSettings: vi.fn(() => state.settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      state.settings = { ...state.settings, ...updates } as GlobalSettings
      return state.settings
    })
  } as unknown as Store
  return { store, state }
}

function registerWith(telemetry: GlobalSettings['telemetry']): FakeStoreState {
  const { store, state } = makeFakeStore(telemetry)
  registerTelemetryHandlers(store)
  captureHandlers()
  return state
}

describe('telemetry IPC handlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    trackMock.mockReset()
    setOptInMock.mockReset()
    persistBannerAcknowledgeMock.mockReset()
    consumeConsentMutationTokenMock.mockReset()
    consumeConsentMutationTokenMock.mockReturnValue(true)
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 0 })
    _resetStoreForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers all four channels', () => {
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: false,
      optedIn: true
    })
    expect(handlers.has('telemetry:track')).toBe(true)
    expect(handlers.has('telemetry:setOptIn')).toBe(true)
    expect(handlers.has('telemetry:acknowledgeBanner')).toBe(true)
    expect(handlers.has('telemetry:getConsentState')).toBe(true)
  })

  // ── telemetry:track ──────────────────────────────────────────────────

  it('forwards a well-typed track call to track() and injects cohort for COHORT_EXTENDED events', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
    const handler = handlers.get('telemetry:track')!
    handler({}, 'app_opened', {})
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('app_opened', { nth_repo_added: 2 })
  })

  // The IPC handler's selectivity is load-bearing: schemas are `.strict()`,
  // so injecting `nth_repo_added` on a non-cohort event would silently
  // drop the entire event at the validator. Events outside `COHORT_EXTENDED`
  // must reach `track()` unmodified.
  it('does NOT inject cohort on events outside COHORT_EXTENDED', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    const handler = handlers.get('telemetry:track')!
    handler({}, 'settings_changed', { setting_key: 'editorAutoSave', value_kind: 'bool' })
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('settings_changed', {
      setting_key: 'editorAutoSave',
      value_kind: 'bool'
    })
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })

  // The renderer-only Setup-step events fire from React `onClick` and
  // depend on the IPC handler injecting cohort — call sites stay
  // synchronous and pass only their own props.
  it('injects cohort for add_repo_setup_step_action (renderer-only event)', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 1 })
    const handler = handlers.get('telemetry:track')!
    handler({}, 'add_repo_setup_step_action', { action: 'skip' })
    expect(trackMock).toHaveBeenCalledWith('add_repo_setup_step_action', {
      action: 'skip',
      nth_repo_added: 1
    })
  })

  // Fail-soft: a degraded classifier returns `{ nth_repo_added: undefined }`.
  // The schemas declare the field optional, so the event still validates.
  it('forwards undefined cohort when the classifier returns undefined', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: undefined })
    const handler = handlers.get('telemetry:track')!
    handler({}, 'app_opened', {})
    expect(trackMock).toHaveBeenCalledWith('app_opened', { nth_repo_added: undefined })
  })

  it('drops track calls with a non-string name', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    const handler = handlers.get('telemetry:track')!
    handler({}, 42, {})
    handler({}, null, {})
    handler({}, { event: 'app_opened' }, {})
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('drops track calls with non-object props', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    const handler = handlers.get('telemetry:track')!
    handler({}, 'app_opened', 'string-not-object')
    handler({}, 'app_opened', 42)
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('treats null/undefined props as an empty object', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 0 })
    const handler = handlers.get('telemetry:track')!
    handler({}, 'app_opened', null)
    handler({}, 'app_opened', undefined)
    expect(trackMock).toHaveBeenCalledTimes(2)
    expect(trackMock).toHaveBeenNthCalledWith(1, 'app_opened', { nth_repo_added: 0 })
    expect(trackMock).toHaveBeenNthCalledWith(2, 'app_opened', { nth_repo_added: 0 })
  })

  // ── telemetry:setOptIn — input narrowing ─────────────────────────────

  it('drops setOptIn with non-boolean optedIn', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    const handler = handlers.get('telemetry:setOptIn')!
    handler({}, 'true')
    handler({}, 1)
    handler({}, null)
    handler({}, undefined)
    expect(setOptInMock).not.toHaveBeenCalled()
    // None of these should have consumed a mutation token either.
    expect(consumeConsentMutationTokenMock).not.toHaveBeenCalled()
  })

  it('drops setOptIn past the consent-mutation rate limit', () => {
    registerWith({ installId: 'x', existedBeforeTelemetryRelease: false, optedIn: true })
    const handler = handlers.get('telemetry:setOptIn')!
    consumeConsentMutationTokenMock.mockReturnValue(false)
    handler({}, true)
    expect(setOptInMock).not.toHaveBeenCalled()
  })

  // ── telemetry:setOptIn — `via` derivation ────────────────────────────

  it("derives via='first_launch_banner' for an existing user with optedIn=null clicking Turn off", () => {
    // Existing-user notice is the only path where an existing user (cohort
    // marker true) with optedIn=null flips to false. That is the contract
    // the notice's "Turn off" button routes through.
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: true,
      optedIn: null
    })
    const handler = handlers.get('telemetry:setOptIn')!
    handler({}, false)
    expect(setOptInMock).toHaveBeenCalledWith('first_launch_banner', false)
  })

  it("derives via='settings' (not 'first_launch_banner') for a defensive opt-in call from the pre-notice state", () => {
    // Defensive: the notice's opt-in path is the ✕ (silent acknowledge),
    // which does NOT route through setOptIn. A compromised renderer
    // could try to call telemetrySetOptIn(true) in the pre-notice state
    // and synthesize a spurious telemetry_opted_in { via:
    // 'first_launch_banner' }. The derivation must refuse that tag for
    // the true-incoming case and fall through to 'settings'.
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: true,
      optedIn: null
    })
    const handler = handlers.get('telemetry:setOptIn')!
    handler({}, true)
    expect(setOptInMock).toHaveBeenCalledWith('settings', true)
  })

  it("derives via='settings' for a new user toggling off from Settings (no first-launch surface exists)", () => {
    // New users (existedBeforeTelemetryRelease=false) are initialized with
    // optedIn=true at migration and see no first-launch surface. Any
    // opt-out from this cohort routes through Settings → Privacy and
    // must tag as `via: 'settings'`.
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: false,
      optedIn: true
    })
    const handler = handlers.get('telemetry:setOptIn')!
    handler({}, false)
    expect(setOptInMock).toHaveBeenCalledWith('settings', false)
  })

  it("derives via='settings' for an opt-in toggle flip after a prior opt-out", () => {
    // User flipped off in Settings, flipping back on in Settings. Neither
    // cohort marker nor notice state triggers a first-launch tag.
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: true,
      optedIn: false
    })
    const handler = handlers.get('telemetry:setOptIn')!
    handler({}, true)
    expect(setOptInMock).toHaveBeenCalledWith('settings', true)
  })

  it("derives via='settings' for a new user flipping Settings off→on (not a first-launch interaction)", () => {
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: false,
      optedIn: false
    })
    const handler = handlers.get('telemetry:setOptIn')!
    handler({}, true)
    expect(setOptInMock).toHaveBeenCalledWith('settings', true)
  })

  it("derives via='settings' when the telemetry block is missing (defensive)", () => {
    // Should never happen post-migration, but if it does the handler must
    // fall through to 'settings' rather than throwing or mis-tagging.
    registerWith(undefined)
    const handler = handlers.get('telemetry:setOptIn')!
    handler({}, true)
    expect(setOptInMock).toHaveBeenCalledWith('settings', true)
  })

  // ── telemetry:acknowledgeBanner — silent-persist path ────────────────

  it('routes banner ✕ through persistBannerAcknowledgeWithoutEmitting without invoking setOptIn', () => {
    // This is the whole point of the separate channel: the silent-persist
    // path MUST NOT reach setOptIn, which would derive a `via` and fire
    // `telemetry_opted_in`. The client primitive may unlock `app_opened`,
    // but the acknowledge channel itself must not emit an opt-in event.
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: true,
      optedIn: null
    })
    const handler = handlers.get('telemetry:acknowledgeBanner')!
    handler({})
    expect(persistBannerAcknowledgeMock).toHaveBeenCalledTimes(1)
    expect(setOptInMock).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('acknowledgeBanner consumes a consent-mutation token and drops past the cap', () => {
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: true,
      optedIn: null
    })
    const handler = handlers.get('telemetry:acknowledgeBanner')!
    consumeConsentMutationTokenMock.mockReturnValue(false)
    handler({})
    expect(persistBannerAcknowledgeMock).not.toHaveBeenCalled()
  })

  // ── telemetry:acknowledgeBanner — state-precondition guard ───────────
  // These tests pin the guard, which rejects any cohort/optedIn
  // combination other than (existed=true, optedIn=null). The guard is
  // the defense against a compromised renderer silently flipping
  // optedIn=true for a user who already resolved consent — a future
  // refactor that weakens it must fail here. The guard also runs BEFORE
  // consumeConsentMutationToken, so a rejected call must not burn a
  // token either.

  it('acknowledgeBanner rejects an existing user who already opted in', () => {
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: true,
      optedIn: true
    })
    const handler = handlers.get('telemetry:acknowledgeBanner')!
    handler({})
    expect(persistBannerAcknowledgeMock).not.toHaveBeenCalled()
    expect(consumeConsentMutationTokenMock).not.toHaveBeenCalled()
  })

  it('acknowledgeBanner rejects an existing user who already opted out', () => {
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: true,
      optedIn: false
    })
    const handler = handlers.get('telemetry:acknowledgeBanner')!
    handler({})
    expect(persistBannerAcknowledgeMock).not.toHaveBeenCalled()
    expect(consumeConsentMutationTokenMock).not.toHaveBeenCalled()
  })

  it('acknowledgeBanner rejects the new-user cohort regardless of optedIn', () => {
    registerWith({
      installId: 'x',
      existedBeforeTelemetryRelease: false,
      optedIn: true
    })
    const handler = handlers.get('telemetry:acknowledgeBanner')!
    handler({})
    expect(persistBannerAcknowledgeMock).not.toHaveBeenCalled()
    expect(consumeConsentMutationTokenMock).not.toHaveBeenCalled()
  })

  it('acknowledgeBanner rejects a missing telemetry block', () => {
    registerWith(undefined)
    const handler = handlers.get('telemetry:acknowledgeBanner')!
    handler({})
    expect(persistBannerAcknowledgeMock).not.toHaveBeenCalled()
    expect(consumeConsentMutationTokenMock).not.toHaveBeenCalled()
  })
})
