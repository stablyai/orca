import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Store } from '../persistence'
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
vi.mock('./posthog-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof PostHogTransport>()),
  createPostHogClient
}))

const realTransport = await vi.importActual<typeof PostHogTransport>('./posthog-transport')
const { initTelemetry, setOptIn, shutdownTelemetry, track } = await import('./client')
const realSetTimeout = globalThis.setTimeout
// SDK gzip is really async, so wait in real time while the fake clock stands still.
async function settle(done: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 10))
  }
}
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

  it('flushes held events 10s after the first one, as an eager client would', () => {
    track('app_opened', {})
    vi.advanceTimersByTime(2_000)
    scheduleClientStart.mock.calls[0][0]()
    vi.advanceTimersByTime(7_999)
    expect(sdk.flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)

    expect(sdk.flush).toHaveBeenCalledTimes(1)
  })

  it('starts and flushes on that deadline when no window ever shows', () => {
    track('app_opened', {})

    vi.advanceTimersByTime(10_000)

    expect(sdk.capture).toHaveBeenCalledWith(expect.objectContaining({ event: 'app_opened' }))
    expect(sdk.flush).toHaveBeenCalledTimes(1)
  })

  it('sends a full batch of held events immediately, as the SDK flushAt threshold would', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    createPostHogClient.mockImplementation(realTransport.createPostHogClient)
    for (let i = 0; i < realTransport.POSTHOG_FLUSH_AT; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 29, 0, 0, 0, i)))
      expect(track('telemetry_opted_in', { via: 'settings' })).toBe(true)
    }

    // Gzip is really async; waitFor's fake-clock advance stays under the 10s flush deadline.
    await vi.waitFor(
      () =>
        expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/batch'), expect.anything()),
      { timeout: 5_000, interval: 50 }
    )
  })

  it.each([200, 400])(
    'leaves batching to the SDK after a flushAt send answered %i, matching an eager client',
    async (firstStatus) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
      fetch.mockImplementationOnce(async () => new Response('{}', { status: firstStatus }))
      vi.stubGlobal('fetch', fetch)
      createPostHogClient.mockImplementation(realTransport.createPostHogClient)
      for (let i = 0; i < realTransport.POSTHOG_FLUSH_AT; i++) {
        track('telemetry_opted_in', { via: 'settings' })
        vi.advanceTimersByTime(50)
      }
      await settle(() => fetch.mock.calls.length === 1)
      await vi.advanceTimersByTimeAsync(1_000)
      track('telemetry_opted_in', { via: 'settings' })
      await settle(() => false)

      // An eager client's interval restarted at the 2s capture; the startup deadline must not flush at 10s.
      await vi.advanceTimersByTimeAsync(8_500)
      await settle(() => fetch.mock.calls.length > 1)
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_600)
      await settle(() => fetch.mock.calls.length > 1)
      expect(fetch).toHaveBeenCalledTimes(2)
    }
  )

  it('drops held events when consent is withdrawn before the client starts', () => {
    track('app_opened', {})
    settings.telemetry!.optedIn = false

    scheduleClientStart.mock.calls[0][0]()

    expect(sdk.capture).not.toHaveBeenCalled()
  })

  it('drops held events at quit without loading the SDK when consent was withdrawn', async () => {
    track('app_opened', {})
    settings.telemetry!.optedIn = false

    await shutdownTelemetry()

    expect(createPostHogClient).not.toHaveBeenCalled()
  })

  it('starts the client early to flush held events and enqueue the opt-out before opting out', async () => {
    track('app_opened', {})
    const order: string[] = []
    sdk.capture.mockImplementation((message: { event?: string; uuid?: string }) => {
      order.push(`capture:${message.event}`)
      queueMicrotask(() => sdk.emitForTests('capture', message))
    })
    sdk.optOut.mockImplementation(async () => {
      order.push('optOut')
    })

    await setOptIn('settings', false)

    expect(order).toEqual(['capture:app_opened', 'capture:telemetry_opted_out', 'optOut'])
  })

  it('still saves an opt-out when the client cannot start', async () => {
    createPostHogClient.mockImplementation(() => {
      throw new Error('sdk failed to load')
    })

    await setOptIn('settings', false)

    expect(store.getSettings().telemetry?.optedIn).toBe(false)
  })

  it('starts the client at quit to flush events held before its start', async () => {
    track('app_opened', {})

    await shutdownTelemetry()

    expect(sdk.capture).toHaveBeenCalledWith(expect.objectContaining({ event: 'app_opened' }))
    expect(sdk.shutdown).toHaveBeenCalledTimes(1)
  })
})
