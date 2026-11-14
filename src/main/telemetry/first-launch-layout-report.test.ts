import type * as crypto from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TelemetrySettings } from '../../shared/telemetry-settings-types'
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
  Object.assign(globalThis, {
    ORCA_BUILD_IDENTITY: 'stable',
    ORCA_POSTHOG_WRITE_KEY: 'test-key'
  })
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
const { reportFirstLaunchLayout } = await import('./first-launch-layout-report')

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'ORCA_BUILD_IDENTITY')
  Reflect.deleteProperty(globalThis, 'ORCA_POSTHOG_WRITE_KEY')
})

let envStash: Record<string, string | undefined>
let sdk: MockPostHog

beforeEach(() => {
  envStash = stashAndClearConsentEnv()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  sdk = makeMockPostHog()
  createPostHogClient.mockImplementation(() => sdk)
})

afterEach(async () => {
  await shutdownTelemetry()
  vi.restoreAllMocks()
  createPostHogClient.mockReset()
  restoreConsentEnv(envStash)
})

function launch(telemetry: Partial<TelemetrySettings>): {
  store: Store
  settings: GlobalSettings
} {
  const settings = makeFakeSettings({
    optedIn: true,
    installId: BASE_COMMON.install_id,
    existedBeforeTelemetryRelease: false,
    protectedMilestones: { installCohort: 'fresh' },
    ...telemetry
  })
  const store = makeFakeStore(settings)
  initTelemetry(store, (start) => start())
  reportFirstLaunchLayout(store)
  return { store, settings }
}

function captured(): { event: string; properties: Record<string, unknown> }[] {
  return sdk.capture.mock.calls.map(([message]) => message)
}

describe('first launch layout report', () => {
  it('reports once and labels later events, including after restart', async () => {
    const { settings } = launch({ firstLaunchLayout: 'project-picker' })
    track('app_opened', {})
    expect(settings.telemetry?.firstLaunchLayoutReport).toBe('sent')
    expect(captured().map((message) => message.event)).toEqual([
      'first_launch_layout_shown',
      'app_opened'
    ])
    expect(captured()[0].properties).toMatchObject({
      layout: 'project-picker',
      fresh_profile: true,
      first_launch_layout_v1: 'project-picker'
    })
    expect(captured()[1].properties.first_launch_layout_v1).toBe('project-picker')

    await shutdownTelemetry()
    sdk.capture.mockClear()
    launch({ ...settings.telemetry })
    track('app_opened', {})
    expect(captured().map((message) => message.event)).toEqual(['app_opened'])
    expect(captured()[0].properties.first_launch_layout_v1).toBe('project-picker')
  })

  it.each([
    ['an environment opt-out', { DO_NOT_TRACK: '1' }, {}],
    ['a saved opt-out', {}, { optedIn: false }]
  ] as const)(
    'skips for good under %s and never labels events after a later opt-in',
    async (_case, env, telemetry) => {
      Object.assign(process.env, env)
      const { settings } = launch({
        firstLaunchLayout: 'home-workspace',
        ...telemetry
      })
      expect(settings.telemetry?.firstLaunchLayoutReport).toBe('skipped')
      expect(settings.telemetry?.firstLaunchLayout).toBe('home-workspace')

      for (const key of Object.keys(env)) {
        delete process.env[key]
      }
      settings.telemetry = { ...settings.telemetry!, optedIn: true }
      track('app_opened', {})
      expect(captured().map((message) => message.event)).toEqual(['app_opened'])
      expect(captured()[0].properties.first_launch_layout_v1).toBeUndefined()

      await shutdownTelemetry()
      sdk.capture.mockClear()
      launch({ ...settings.telemetry })
      track('app_opened', {})
      expect(captured().map((message) => message.event)).toEqual(['app_opened'])
      expect(captured()[0].properties.first_launch_layout_v1).toBeUndefined()
    }
  )

  it('does nothing for profiles without a first launch layout', () => {
    const { settings } = launch({})
    track('app_opened', {})
    expect(settings.telemetry?.firstLaunchLayoutReport).toBeUndefined()
    expect(captured().map((message) => message.event)).toEqual(['app_opened'])
    expect(captured()[0].properties.first_launch_layout_v1).toBeUndefined()
  })
})
