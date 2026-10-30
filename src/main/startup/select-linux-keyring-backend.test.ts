import { beforeEach, describe, expect, it, vi } from 'vitest'

const appendSwitch = vi.hoisted(() => vi.fn())
const hasSwitch = vi.hoisted(() => vi.fn(() => false))
vi.mock('electron', () => ({ app: { commandLine: { appendSwitch, hasSwitch } } }))

const probeSecretServiceCollection = vi.hoisted(() => vi.fn(() => 'unlocked'))
vi.mock('./linux-secret-service-probe', () => ({ probeSecretServiceCollection }))

const { selectLinuxKeyringBackend } = await import('./select-linux-keyring-backend')

function withEnvAndPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  run: (log: ReturnType<typeof vi.fn>) => void
): void {
  const originalPlatform = process.platform
  const originalEnv = process.env
  const originalArgv = process.argv
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  process.env = env
  process.argv = ['electron', '.']
  const log = vi.fn()
  try {
    selectLinuxKeyringBackend(log)
    run(log)
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    process.env = originalEnv
    process.argv = originalArgv
  }
}

const HYPRLAND = {
  XDG_CURRENT_DESKTOP: 'Hyprland',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
}

describe('selectLinuxKeyringBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasSwitch.mockReturnValue(false)
    probeSecretServiceCollection.mockReturnValue('unlocked')
  })

  it('appends the switch and logs why on an unrecognised Linux desktop', () => {
    withEnvAndPlatform('linux', HYPRLAND, (log) => {
      expect(appendSwitch).toHaveBeenCalledExactlyOnceWith('password-store', 'gnome-libsecret')
      expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('gnome-libsecret'))
    })
  })

  it('stays silent when it changes nothing, so ordinary launches log nothing', () => {
    probeSecretServiceCollection.mockReturnValue('locked')
    withEnvAndPlatform('linux', HYPRLAND, (log) => {
      expect(appendSwitch).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    })
  })

  // macOS and Windows have no --password-store concept; the probe must never spawn there.
  it.each(['darwin', 'win32'] as const)('does nothing at all on %s', (platform) => {
    withEnvAndPlatform(platform, HYPRLAND, () => {
      expect(appendSwitch).not.toHaveBeenCalled()
      expect(probeSecretServiceCollection).not.toHaveBeenCalled()
    })
  })

  it('defers to a switch Electron already holds', () => {
    hasSwitch.mockReturnValue(true)
    withEnvAndPlatform('linux', HYPRLAND, () => {
      expect(appendSwitch).not.toHaveBeenCalled()
    })
  })
})
