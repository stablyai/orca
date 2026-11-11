import 'node:crypto'
import type * as crypto from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Store } from '../persistence/loading-store/store'
import type * as PostHogTransport from './posthog-transport'
import {
  BASE_COMMON,
  makeFakeSettings,
  makeFakeStore,
  makeMockPostHog,
  type MockPostHog,
  restoreConsentEnv,
  stashAndClearConsentEnv
} from './client-test-harness'

const { createPostHogClient } = vi.hoisted(() => {
  // Official-build identity is read at import; set it before client.ts loads.
  Object.assign(globalThis, { ORCA_BUILD_IDENTITY: 'stable', ORCA_POSTHOG_WRITE_KEY: 'test-key' })
  return { createPostHogClient: vi.fn() }
})
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof crypto>()),
  randomInt: vi.fn(() => 0)
}))
vi.mock('./posthog-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof PostHogTransport>()),
  createPostHogClient
}))
const { initTelemetry, shutdownTelemetry, track } = await import('./client')
const scheduleClientStart = vi.fn<(start: () => void) => void>()

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'ORCA_BUILD_IDENTITY')
  Reflect.deleteProperty(globalThis, 'ORCA_POSTHOG_WRITE_KEY')
})

describe('deferred PostHog client start', () => {
  let envStash: Record<string, string | undefined>
  let settings: GlobalSettings
  let store: Store
  let sdk: MockPostHog & { flush: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-29T00:00:00Z') })
    envStash = stashAndClearConsentEnv()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    sdk = { ...makeMockPostHog(), flush: vi.fn(async () => {}) }
    createPostHogClient.mockImplementation(() => sdk)
    settings = makeFakeSettings({
      optedIn: true,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: false
    })
    store = makeFakeStore(settings)
    initTelemetry(store, scheduleClientStart)
  })

  afterEach(async () => {
    await shutdownTelemetry()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    createPostHogClient.mockReset()
    scheduleClientStart.mockReset()
    restoreConsentEnv(envStash)
  })

  it('holds startup events, then replays them in order with their original timestamps', () => {
    expect(track('app_opened', {})).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(track('telemetry_opted_in', { via: 'settings' })).toBe(true)
    expect(createPostHogClient).not.toHaveBeenCalled()

    const [[startClient]] = scheduleClientStart.mock.calls
    startClient()

    expect(createPostHogClient).toHaveBeenCalledTimes(1)
    const captured = sdk.capture.mock.calls.map(([message]) => message)
    expect(captured.map((message) => [message.event, message.timestamp])).toEqual([
      ['app_opened', new Date('2026-10-29T00:00:00Z')],
      ['telemetry_opted_in', new Date('2026-10-29T00:00:01Z')]
    ])
  })

  it('drops held events when consent is withdrawn before the client starts', () => {
    track('app_opened', {})
    settings.telemetry!.optedIn = false

    scheduleClientStart.mock.calls[0][0]()

    expect(sdk.capture).not.toHaveBeenCalled()
  })
})
