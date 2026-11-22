import type * as crypto from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { TelemetrySettings } from '../../shared/telemetry/telemetry-settings-types'
import type { Store } from '../persistence/loading-store/store'
import type * as PostHogTransport from './posthog-transport'
import type { ConsentState } from './consent'
import type { CommonProps } from '../../shared/telemetry/telemetry-event-classification'

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
type MockPostHog = {
  optedOut: boolean
  capture: ReturnType<typeof vi.fn>
  optIn: ReturnType<typeof vi.fn>
  optOut: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emitForTests: (event: string, payload: unknown) => void
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

function makeMockPostHog(): MockPostHog {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emitForTests = (event: string, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload)
    }
  }

  const sdk: MockPostHog = {
    optedOut: false,
    capture: vi.fn((message: { event?: string; uuid?: string }) => {
      queueMicrotask(() => {
        emitForTests('capture', {
          event: message.event,
          uuid: message.uuid
        })
      })
    }),
    optIn: vi.fn(async () => {
      sdk.optedOut = false
    }),
    optOut: vi.fn(async () => {
      sdk.optedOut = true
    }),
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
  return sdk
}

function makeFakeSettings(telemetry: GlobalSettings['telemetry']): GlobalSettings {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: telemetry reads only the telemetry settings.
  return { telemetry } as unknown as GlobalSettings
}

function makeFakeStore(settings: GlobalSettings): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakes every Store method telemetry reads or writes; other methods are never called.
  return {
    getSettings: vi.fn(() => settings),
    getUI: vi.fn(() => ({ featureTipsSeenIds: [] })),
    getChatUiLaunchTipVariant: vi.fn(() => 'none'),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      if (updates.telemetry) {
        settings.telemetry = {
          ...settings.telemetry,
          ...updates.telemetry
        }
      }
      return settings
    })
  } as unknown as Store
}

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

const { initTelemetry, setOptIn, shutdownTelemetry, track } = await import('./client')
const { shouldOptOutSdkAtInit } = await import('./posthog-transport')
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
  createPostHogClient.mockImplementation((_writeKey: string, consent: ConsentState) => {
    sdk.optedOut = shouldOptOutSdkAtInit(consent)
    return sdk
  })
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
      await setOptIn('settings', true)
      expect(captured().map((message) => message.event)).toEqual([
        'app_opened',
        'telemetry_opted_in'
      ])
      for (const message of captured()) {
        expect(message.properties.first_launch_layout_v1).toBeUndefined()
      }

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
