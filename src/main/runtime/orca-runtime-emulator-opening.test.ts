import { describe, expect, it, vi } from 'vitest'
import { EmulatorBridge } from '../emulator/emulator-bridge'
import { RuntimeEmulatorCommands } from './orca-runtime-emulator'
import { RuntimeEmulatorAttach } from './runtime-emulator-attach'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { EmulatorSessionInfo } from '../emulator/emulator-types'
import type { EmulatorDevice } from '../emulator/backends/emulator-backend'
const devices: EmulatorDevice[] = [
  { backend: 'ios', id: 'iphone', name: 'iPhone', state: 'shutdown', isAvailable: true },
  {
    backend: 'android',
    id: 'emulator-5558',
    name: 'Pixel',
    detail: 'emulator',
    state: 'booted',
    isAvailable: true
  }
]
function info(id: string): EmulatorSessionInfo {
  return {
    deviceUdid: id,
    streamUrl: `http://localhost/${id}`,
    wsUrl: `ws://localhost/${id}`,
    helperPid: 1
  }
}
function setup() {
  const bridge = new EmulatorBridge()
  const settings: Pick<
    GlobalSettings,
    | 'mobileEmulatorEnabled'
    | 'mobileEmulatorDefaultDeviceUdid'
    | 'mobileEmulatorRecentDevices'
    | 'mobileEmulatorOpeningMode'
  > = { mobileEmulatorEnabled: true }
  vi.spyOn(bridge, 'listAllDevices').mockResolvedValue(devices)
  vi.spyOn(bridge, 'listSimulators').mockResolvedValue([
    { name: 'iPhone', udid: 'iphone', state: 'Shutdown', runtime: 'iOS 27.2', isAvailable: true }
  ])
  vi.spyOn(bridge, 'getReusableActiveForWorktree').mockResolvedValue(null)
  vi.spyOn(bridge, 'stopActiveForSwitch').mockResolvedValue(null)
  vi.spyOn(bridge, 'registerActiveEmulator').mockImplementation(() => {})
  const acquire = vi
    .spyOn(bridge, 'acquireHelperForDevice')
    .mockImplementation(async (id) => ({ info: info(id), release: async () => {} }))
  const commands = new RuntimeEmulatorCommands({
    getEmulatorBridge: () => bridge,
    getSettings: () => settings,
    updateEmulatorSettings: (updates) => Object.assign(settings, updates),
    resolveEmulatorWorkspaceId: async (id) => id,
    resolveEmulatorCleanupWorkspaceId: async (id) => id,
    getAuthoritativeWindow: () => {
      throw new Error('Headless test')
    }
  })
  return { commands, bridge, settings, acquire }
}
describe('user emulator opening', () => {
  it('does not boot on first user opening, while preserving CLI auto-selection', async () => {
    const { commands, acquire } = setup()
    expect(await commands.emulatorAttach({ userInitiated: true })).toMatchObject({
      attached: false,
      selectionRequired: 'first-use'
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(await commands.emulatorAttach({})).toMatchObject({
      attached: true,
      info: { deviceUdid: 'iphone' }
    })
  })
  it('remembers only successful deliberate UI selection and keeps host preferences isolated', async () => {
    const { commands, settings, acquire } = setup()
    await commands.emulatorAttach({ device: 'emulator-5558' })
    expect(settings.mobileEmulatorRecentDevices).toBeUndefined()
    acquire.mockRejectedValueOnce(new Error('boot failed'))
    await expect(
      commands.emulatorAttach({ device: 'iphone', userInitiated: true })
    ).rejects.toThrow('boot failed')
    expect(settings.mobileEmulatorRecentDevices).toBeUndefined()
    await commands.emulatorAttach({ device: 'emulator-5558', userInitiated: true })
    expect(settings.mobileEmulatorRecentDevices?.[0]).toMatchObject({
      id: 'Pixel',
      kind: 'avd',
      backend: 'android'
    })
    expect(setup().settings.mobileEmulatorRecentDevices).toBeUndefined()
  })
  it('reuses the current workspace session even when opening mode is ask', async () => {
    const { commands, settings, bridge, acquire } = setup()
    settings.mobileEmulatorOpeningMode = 'ask'
    vi.mocked(bridge.getReusableActiveForWorktree).mockResolvedValue(info('emulator-5558'))
    expect(
      await commands.emulatorAttach({ worktree: 'folder:project', userInitiated: true })
    ).toMatchObject({ attached: true, info: { deviceUdid: 'emulator-5558' } })
    expect(acquire).not.toHaveBeenCalled()
  })
  it('ignores a late completion when a newer deliberate selection succeeded', async () => {
    const { commands, settings, acquire } = setup()
    let finish: (
      value: Awaited<ReturnType<EmulatorBridge['acquireHelperForDevice']>>
    ) => void = () => {}
    acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const first = commands
      .emulatorAttach({ device: 'iphone', worktree: 'project', userInitiated: true })
      .catch((error) => error)
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))
    await commands.emulatorAttach({
      device: 'emulator-5558',
      worktree: 'project',
      userInitiated: true
    })
    finish({ info: info('iphone'), release: async () => {} })
    expect(await first).toMatchObject({ code: 'emulator_attach_superseded' })
    expect(settings.mobileEmulatorRecentDevices?.[0].id).toBe('Pixel')
  })
})

describe('successful attach with unavailable preference storage', () => {
  it.each([false, true])(
    'still notifies and returns success when saving fails (reuse=%s)',
    async (reuse) => {
      const { bridge, settings } = setup()
      if (reuse) {
        vi.mocked(bridge.getReusableActiveForWorktree).mockResolvedValue(info('emulator-5558'))
      }
      const failure = new Error('preference storage unavailable')
      const notified = vi.fn()
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const attach = new RuntimeEmulatorAttach(
        {
          getEmulatorBridge: () => bridge,
          getSettings: () => settings,
          updateEmulatorSettings: () => {
            throw failure
          },
          resolveEmulatorWorkspaceId: async (id) => id,
          resolveEmulatorCleanupWorkspaceId: async (id) => id,
          getAuthoritativeWindow: () => {
            throw new Error('Headless test')
          }
        },
        () => bridge,
        notified
      )
      try {
        await expect(
          attach.attach({
            device: 'emulator-5558',
            worktree: 'project',
            userInitiated: true,
            focus: false
          })
        ).resolves.toMatchObject({ attached: true, info: { deviceUdid: 'emulator-5558' } })
        expect(notified).toHaveBeenCalledWith('project', info('emulator-5558'), false)
        expect(warning).toHaveBeenCalledWith(
          '[emulator] Could not save the last-used device',
          failure
        )
      } finally {
        warning.mockRestore()
      }
    }
  )
})
