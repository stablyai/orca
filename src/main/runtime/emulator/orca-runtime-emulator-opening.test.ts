import { describe, expect, it, vi } from 'vitest'
import { EmulatorBridge } from '../../emulator/emulator-bridge'
import { RuntimeEmulatorCommands } from './runtime-emulator-commands'

import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { EmulatorSessionInfo } from '../../emulator/emulator-types'
import type { EmulatorDevice } from '../../emulator/backends/emulator-backend'
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
