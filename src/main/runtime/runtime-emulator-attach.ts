import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { EmulatorError } from '../emulator/emulator-errors'
import { emulatorFailureText } from '../../shared/emulator-failure-copy'
import { resolveDefaultAttachDevice } from '../emulator/emulator-default-attach-device'
import {
  rememberEmulatorDevice,
  resolveEmulatorOpeningPreference
} from '../emulator/emulator-opening-preference'
import type { RuntimeEmulatorCommandHost } from './orca-runtime-emulator'
import type { EmulatorSessionInfo } from '../emulator/emulator-types'
import type { EmulatorSelectionRequired } from '../../shared/emulator-opening-preferences'

export type RuntimeEmulatorAttachParams = {
  device?: string
  worktree?: string
  focus?: boolean
  userInitiated?: boolean
}
type Result = {
  attached: boolean
  info?: EmulatorSessionInfo
  selectionRequired?: EmulatorSelectionRequired
}

export class RuntimeEmulatorAttach {
  private choiceGeneration = 0
  private readonly pendingByWorkspace = new Map<string | undefined, symbol>()
  constructor(
    private readonly host: RuntimeEmulatorCommandHost,
    private readonly requireBridge: () => EmulatorBridge,
    private readonly notify: (
      worktreeId: string,
      info: EmulatorSessionInfo,
      focus?: boolean
    ) => void
  ) {}

  async attach(params: RuntimeEmulatorAttachParams): Promise<Result> {
    const settings = this.host.getSettings()
    if (settings.mobileEmulatorEnabled === false) {
      throw new EmulatorError('emulator_disabled', emulatorFailureText('disabled'))
    }
    const choiceGeneration =
      params.userInitiated && params.device ? ++this.choiceGeneration : undefined
    const bridge = this.requireBridge()
    const ticket = params.userInitiated ? Symbol() : undefined
    if (ticket) {
      this.pendingByWorkspace.set(params.worktree, ticket)
    }
    const assertCurrent = () => {
      if (ticket && this.pendingByWorkspace.get(params.worktree) !== ticket) {
        throw new EmulatorError(
          'emulator_attach_superseded',
          'A newer device selection replaced this connection.'
        )
      }
    }
    let selectedDevice: Awaited<ReturnType<EmulatorBridge['listAllDevices']>>[number] | undefined
    const remember = () => {
      if (
        choiceGeneration === undefined ||
        choiceGeneration !== this.choiceGeneration ||
        !selectedDevice
      ) {
        return
      }
      try {
        const recent = this.host.getSettings().mobileEmulatorRecentDevices ?? []
        this.host.updateEmulatorSettings?.({
          mobileEmulatorRecentDevices: rememberEmulatorDevice(selectedDevice, recent)
        })
      } catch (error) {
        console.warn('[emulator] Could not save the last-used device', error)
      }
    }
    try {
      const worktreeId = params.worktree
        ? await this.host.resolveEmulatorWorkspaceId(params.worktree)
        : undefined
      assertCurrent()
      let device = params.device
      if (params.userInitiated && !device && worktreeId) {
        const active = await bridge.getReusableActiveForWorktree(worktreeId)
        assertCurrent()
        if (active) {
          this.notify(worktreeId, active, params.focus)
          return { attached: true, info: active }
        }
      }
      if (params.userInitiated) {
        const devices = await bridge.listAllDevices()
        assertCurrent()
        if (!device) {
          const selection = resolveEmulatorOpeningPreference(settings, devices)
          if ('selectionRequired' in selection) {
            return { attached: false, ...selection }
          }
          device = selection.device
        }
        selectedDevice = devices.find(
          (item) =>
            item.id === device ||
            (item.backend === 'android' &&
              ['avd', 'emulator'].includes(item.detail ?? '') &&
              item.name === device)
        )
        if (!selectedDevice || selectedDevice.isAvailable === false) {
          return { attached: false, selectionRequired: selectedDevice ? 'unavailable' : 'missing' }
        }
      } else {
        device ??=
          settings.mobileEmulatorDefaultDeviceUdid ?? (await resolveDefaultAttachDevice(bridge))
      }
      if (!device) {
        throw new EmulatorError(
          'emulator_device_not_found',
          emulatorFailureText('noDeviceSpecified')
        )
      }
      if (worktreeId) {
        const reusable = await bridge.getReusableActiveForWorktree(worktreeId, device)
        assertCurrent()
        if (reusable) {
          remember()
          this.notify(worktreeId, reusable, params.focus)
          return { attached: true, info: reusable }
        }
        await bridge.stopActiveForSwitch(worktreeId)
        assertCurrent()
      }
      const lease = await bridge.acquireHelperForDevice(device)
      const { info } = lease
      try {
        assertCurrent()
        if (
          params.worktree &&
          worktreeId &&
          (await this.host.resolveEmulatorWorkspaceId(params.worktree)) !== worktreeId
        ) {
          throw new EmulatorError('emulator_no_active', emulatorFailureText('workspaceChanged'))
        }
        assertCurrent()
      } catch (error) {
        await lease.release({ cleanupIfUnused: true }).catch(() => {})
        if (error instanceof Error && error.message === 'selector_not_found') {
          throw new EmulatorError('emulator_no_active', emulatorFailureText('workspaceChanged'))
        }
        throw error
      }
      if (worktreeId) {
        bridge.registerActiveEmulator(worktreeId, info, { managed: true })
      }
      await lease.release()
      assertCurrent()
      remember()
      if (worktreeId) {
        this.notify(worktreeId, info, params.focus)
      }
      return { attached: true, info }
    } finally {
      if (ticket && this.pendingByWorkspace.get(params.worktree) === ticket) {
        this.pendingByWorkspace.delete(params.worktree)
      }
    }
  }
}
