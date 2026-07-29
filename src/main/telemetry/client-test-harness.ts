import type { PostHog } from 'posthog-node'
import { vi } from 'vitest'
import type { CommonProps } from '../../shared/telemetry-events'
import type { GlobalSettings } from '../../shared/types'
import type { Store } from '../persistence'
import { resetBurstCapsForSession } from './burst-cap'
import {
  _enableTransportForTests,
  _resetFirstAppOpenedFiredForTests,
  _setCommonPropsForTests,
  _setPostHogClientForTests,
  _setShuttingDownForTests,
  _setStoreForTests
} from './client'

export type MockPostHog = {
  capture: ReturnType<typeof vi.fn>
  optIn: ReturnType<typeof vi.fn>
  optOut: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emitForTests: (event: string, payload: unknown) => void
}

export type TelemetryClientTestState = {
  mock: MockPostHog
  store: Store
  settings: GlobalSettings
  envStash: Record<string, string | undefined>
}

export const BASE_COMMON: CommonProps = {
  app_version: '1.3.33',
  platform: 'darwin',
  arch: 'arm64',
  os_release: '25.3.0',
  install_id: '00000000-0000-4000-8000-000000000000',
  session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  orca_channel: 'stable'
}

export function makeMockPostHog(): MockPostHog {
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

export function makeFakeSettings(telemetry: GlobalSettings['telemetry']): GlobalSettings {
  return { telemetry } as unknown as GlobalSettings
}

export function makeFakeStore(settings: GlobalSettings): Store {
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

export function setupTelemetryClientTest(
  telemetry: GlobalSettings['telemetry'] = {
    optedIn: true,
    installId: BASE_COMMON.install_id,
    existedBeforeTelemetryRelease: false
  }
): TelemetryClientTestState {
  const envStash = stashAndClearConsentEnv()
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetBurstCapsForSession()

  const mock = makeMockPostHog()
  const settings = makeFakeSettings(telemetry)
  const store = makeFakeStore(settings)
  _setPostHogClientForTests(mock as unknown as PostHog)
  _setCommonPropsForTests(BASE_COMMON)
  _setStoreForTests(store)
  _setShuttingDownForTests(false)
  _enableTransportForTests(true)
  _resetFirstAppOpenedFiredForTests()

  return { mock, store, settings, envStash }
}

export function cleanupTelemetryClientTest(envStash: Record<string, string | undefined>): void {
  _enableTransportForTests(false)
  _setPostHogClientForTests(null)
  _setCommonPropsForTests(null)
  _setStoreForTests(null)
  _resetFirstAppOpenedFiredForTests()
  vi.restoreAllMocks()
  restoreConsentEnv(envStash)
}
