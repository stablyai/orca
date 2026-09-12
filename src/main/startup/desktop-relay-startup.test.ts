import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  configured: true,
  serviceOptions: null as null | { hostMobilePairingConnectionMode?: () => string },
  service: {
    start: vi.fn(),
    pairingPolicyChanged: vi.fn(),
    createPairingRelay: vi.fn(),
    onDeviceRevokeQueued: vi.fn(),
    demandStateChanged: vi.fn(),
    getEndpoints: vi.fn(),
    provisionRelay: vi.fn(),
    ensureLive: vi.fn()
  },
  settingsListeners: [] as ((updates: Record<string, unknown>) => void)[],
  settings: { mobilePairingConnectionMode: undefined as string | undefined }
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  powerMonitor: { on: vi.fn() }
}))
vi.mock('../orca-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: fakes.configured, config: {} })
}))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/tmp/orca-test'
}))
vi.mock('../runtime/relay/desktop-relay-service', () => ({
  DesktopRelayService: class {
    constructor(options: typeof fakes.serviceOptions) {
      fakes.serviceOptions = options
      return fakes.service
    }
  }
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    store: {
      getSettings: () => fakes.settings,
      onSettingsChanged: (listener: (updates: Record<string, unknown>) => void) => {
        fakes.settingsListeners.push(listener)
        return () => {}
      }
    },
    desktopRelayService: null,
    mainWindow: null
  }
}))

import { startDesktopRelayService } from './desktop-relay-startup'
import { mainProcessState } from './main-process-state'

describe('startDesktopRelayService (#18211 host policy wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.configured = true
    fakes.serviceOptions = null
    fakes.settingsListeners.length = 0
    fakes.settings.mobilePairingConnectionMode = undefined
    mainProcessState.desktopRelayService = null
    startDesktopRelayService({ setMobileRelayPairingProvider: vi.fn() } as never)
  })

  it('reads the live host pairing mode from settings, defaulting to automatic', () => {
    const read = fakes.serviceOptions?.hostMobilePairingConnectionMode
    expect(read?.()).toBe('automatic')
    fakes.settings.mobilePairingConnectionMode = 'local-only'
    expect(read?.()).toBe('local-only')
  })

  it('wakes the relay service only when the pairing mode setting changes', () => {
    expect(fakes.settingsListeners).toHaveLength(1)
    fakes.settingsListeners[0]!({ theme: 'dark' })
    expect(fakes.service.pairingPolicyChanged).not.toHaveBeenCalled()
    fakes.settingsListeners[0]!({ mobilePairingConnectionMode: 'local-only' })
    expect(fakes.service.pairingPolicyChanged).toHaveBeenCalledOnce()
  })
})
