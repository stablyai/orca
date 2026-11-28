import type { EmulatorBridge } from '../../emulator/emulator-bridge'
import { EmulatorError } from '../../emulator/emulator-errors'
import { emulatorFailureText } from '../../../shared/emulator/emulator-failure-copy'
import { resolveDefaultAttachDevice } from '../../emulator/emulator-default-attach-device'
import {
  rememberEmulatorDevice,
  resolveEmulatorOpeningPreference
} from '../../emulator/emulator-opening-preference'
import type { RuntimeEmulatorCommandHost } from './runtime-emulator-commands'
import type { EmulatorBackendKind, EmulatorSessionInfo } from '../../emulator/emulator-types'
import {
  getEmulatorOpeningMode,
  type EmulatorSelectionRequired
} from '../../../shared/emulator/emulator-opening-preferences'

export type RuntimeEmulatorAttachParams = {
  device?: string
  /** Only devices of this backend; a paired desktop shows a server's iOS simulators only. */
  backend?: EmulatorBackendKind
  worktree?: string
  focus?: boolean
  userInitiated?: boolean
}
type Result = {
  attached: boolean
  info?: EmulatorSessionInfo
  selectionRequired?: EmulatorSelectionRequired
}

type ListedDevice = Awaited<ReturnType<EmulatorBridge['listAllDevices']>>[number]

/** A device's id, or an Android AVD's name, which Android attaches also accept. */
function namesDevice(item: ListedDevice, device: string): boolean {
  return (
    item.id === device ||
    (item.backend === 'android' &&
      ['avd', 'emulator'].includes(item.detail ?? '') &&
      item.name === device)
  )
}

function otherBackendError(backend: EmulatorBackendKind | undefined): EmulatorError {
  return new EmulatorError(
    'emulator_backend_unsupported',
    `This emulator is ${backend === 'android' ? 'an Android' : 'an iOS'} device, which this window can't show.`
  )
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
    const ofBackend = (item: { backend?: EmulatorBackendKind }) =>
      !params.backend || item.backend === params.backend
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
    let selectedDevice: ListedDevice | undefined
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
      if (!device && worktreeId) {
        // Another backend's session is someone else's (an agent's attach, say), streaming or not;
        // never switch it away.
        const current = bridge.getActiveForWorktree(worktreeId)
        if (current && !ofBackend(current)) {
          throw otherBackendError(current.backend)
        }
        const active = await bridge.getReusableActiveForWorktree(worktreeId)
        assertCurrent()
        if (active) {
          this.notify(worktreeId, active, params.focus)
          return { attached: true, info: active }
        }
      }
      // Listing runs simctl and adb, so one attach lists at most once.
      let listed: Promise<ListedDevice[]> | undefined
      const listAll = (): Promise<ListedDevice[]> => (listed ??= bridge.listAllDevices())
      const explicit = device
      if (explicit && params.backend) {
        const named = (await listAll()).find((item) => namesDevice(item, explicit))
        assertCurrent()
        if (named && !ofBackend(named)) {
          throw otherBackendError(named.backend)
        }
      }
      if (params.userInitiated) {
        const all = await listAll()
        const devices = all.filter(ofBackend)
        assertCurrent()
        if (!device) {
          const current = worktreeId
            ? bridge.getActiveForWorktree(worktreeId)?.deviceUdid
            : undefined
          const selection = resolveEmulatorOpeningPreference(settings, devices, current)
          if ('selectionRequired' in selection) {
            // A saved device of a backend this caller can't show is still there, not missing.
            // The saved device is still there when the full list finds it; it is just another backend.
            const unfiltered = resolveEmulatorOpeningPreference(settings, all, current)
            const hidden =
              selection.selectionRequired === 'missing' &&
              !('selectionRequired' in unfiltered && unfiltered.selectionRequired === 'missing')
            return {
              attached: false,
              selectionRequired: hidden ? 'ask' : selection.selectionRequired
            }
          }
          device = selection.device
        }
        const chosen = device
        selectedDevice = devices.find((item) => namesDevice(item, chosen))
        if (!selectedDevice || selectedDevice.isAvailable === false) {
          return { attached: false, selectionRequired: selectedDevice ? 'unavailable' : 'missing' }
        }
      } else {
        const listAllDevices = async () => (await listAll()).filter(ofBackend)
        device ??= await resolveDefaultAttachDevice(
          { listAllDevices },
          {
            current: worktreeId ? bridge.getActiveForWorktree(worktreeId)?.deviceUdid : undefined,
            // The configured device skips the device list, so a backend-limited attach ignores it.
            configured:
              !params.backend && getEmulatorOpeningMode(settings) === 'specific'
                ? (settings.mobileEmulatorDefaultDeviceUdid ?? undefined)
                : undefined
          }
        )
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
        // An agent may have attached another backend since the check above; never switch it away.
        const switching = bridge.getActiveForWorktree(worktreeId)
        if (!params.device && switching && !ofBackend(switching)) {
          throw otherBackendError(switching.backend)
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
