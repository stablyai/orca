// IPC boundary behavior. Strict type narrows must drop obviously-malformed
// calls before they reach the validator (the renderer is in the threat
// model). Also pins the consent-mutation rate limit: ≤5
// `telemetry:setOptIn` calls per session.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
const { handleMock, trackMock, setOptInMock, consumeConsentMutationTokenMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  trackMock: vi.fn(),
  setOptInMock: vi.fn(),
  consumeConsentMutationTokenMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../telemetry/client', () => ({
  track: trackMock,
  setOptIn: setOptInMock
}))
vi.mock('../telemetry/burst-cap', () => ({
  consumeConsentMutationToken: consumeConsentMutationTokenMock
}))

import { registerTelemetryHandlers } from './telemetry'

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

describe('telemetry IPC handlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    trackMock.mockReset()
    setOptInMock.mockReset()
    consumeConsentMutationTokenMock.mockReset()
    consumeConsentMutationTokenMock.mockReturnValue(true)
    registerTelemetryHandlers()
    captureHandlers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers both channels', () => {
    expect(handlers.has('telemetry:track')).toBe(true)
    expect(handlers.has('telemetry:setOptIn')).toBe(true)
  })

  // ── telemetry:track ──────────────────────────────────────────────────

  it('forwards a well-typed track call to track()', () => {
    const handler = handlers.get('telemetry:track')!
    handler({}, 'app_opened', {})
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('app_opened', {})
  })

  it('drops track calls with a non-string name', () => {
    const handler = handlers.get('telemetry:track')!
    handler({}, 42, {})
    handler({}, null, {})
    handler({}, { event: 'app_opened' }, {})
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('drops track calls with non-object props', () => {
    const handler = handlers.get('telemetry:track')!
    handler({}, 'app_opened', 'string-not-object')
    handler({}, 'app_opened', 42)
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('treats null/undefined props as an empty object', () => {
    const handler = handlers.get('telemetry:track')!
    handler({}, 'app_opened', null)
    handler({}, 'app_opened', undefined)
    expect(trackMock).toHaveBeenCalledTimes(2)
    expect(trackMock).toHaveBeenNthCalledWith(1, 'app_opened', {})
    expect(trackMock).toHaveBeenNthCalledWith(2, 'app_opened', {})
  })

  // ── telemetry:setOptIn ───────────────────────────────────────────────

  it('drops setOptIn with non-boolean optedIn', () => {
    const handler = handlers.get('telemetry:setOptIn')!
    handler({}, 'true')
    handler({}, 1)
    handler({}, null)
    handler({}, undefined)
    expect(setOptInMock).not.toHaveBeenCalled()
    // None of these should have consumed a mutation token either.
    expect(consumeConsentMutationTokenMock).not.toHaveBeenCalled()
  })

  it('forwards a boolean setOptIn to setOptIn(settings, optedIn) when the token is available', () => {
    const handler = handlers.get('telemetry:setOptIn')!
    consumeConsentMutationTokenMock.mockReturnValue(true)
    handler({}, true)
    expect(setOptInMock).toHaveBeenCalledWith('settings', true)
    handler({}, false)
    expect(setOptInMock).toHaveBeenCalledWith('settings', false)
  })

  it('drops setOptIn past the consent-mutation rate limit', () => {
    const handler = handlers.get('telemetry:setOptIn')!
    consumeConsentMutationTokenMock.mockReturnValue(false)
    handler({}, true)
    expect(setOptInMock).not.toHaveBeenCalled()
  })
})
