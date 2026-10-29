import type { BrowserWindow } from 'electron'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { EmulatorError } from '../emulator/emulator-errors'
import { emulatorFailureText } from '../../shared/emulator-failure-copy'
import {
  inspectEmulatorAvailability,
  type EmulatorAvailability
} from '../emulator/emulator-availability'
import { resolveDefaultAttachDevice } from '../emulator/emulator-default-attach-device'
import { setConfiguredAndroidSdkPath } from '../emulator/android/android-sdk-host-discovery'
import type { EmulatorGesturePoint } from '../emulator/emulator-gesture-sender'
import type { EmulatorSessionInfo } from '../emulator/emulator-types'
import type { SimulatorDevice } from '../emulator/simctl-simulator-devices'
import type { EmulatorDevice } from '../emulator/backends/emulator-backend'
import type { GlobalSettings } from '../../shared/global-settings-types'

type EmulatorHostSettings = Pick<
  GlobalSettings,
  'mobileEmulatorEnabled' | 'mobileEmulatorDefaultDeviceUdid' | 'androidSdkPath'
>

export type RuntimeEmulatorCommandHost = {
  getEmulatorBridge(): EmulatorBridge | null
  resolveEmulatorWorkspaceId(selector: string): Promise<string>
  resolveEmulatorCleanupWorkspaceId(selector: string): Promise<string>
  getAuthoritativeWindow(): BrowserWindow
  getSettings(): EmulatorHostSettings
}

type EmulatorTargetParams = { device?: string; emulator?: string; worktree?: string }

export class RuntimeEmulatorCommands {
  constructor(private readonly host: RuntimeEmulatorCommandHost) {}

  private requireEmulatorBridge(): EmulatorBridge {
    const bridge = this.host.getEmulatorBridge()
    if (!bridge) {
      throw new EmulatorError('emulator_no_active', emulatorFailureText('noSession'))
    }
    setConfiguredAndroidSdkPath(this.host.getSettings().androidSdkPath ?? null)
    return bridge
  }

  // RPC must serialize result; undefined would omit it and fail CLI schema validation.
  private static readonly OK = { ok: true as const }

  async emulatorTap(
    params: EmulatorTargetParams & { x: number; y: number }
  ): Promise<{ ok: true }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    await bridge.tap(params.x, params.y, { device: params.device ?? params.emulator, worktreeId })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorGesture(params: {
    points: EmulatorGesturePoint[]
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    await bridge.gesture(params.points, { device: params.device ?? params.emulator, worktreeId })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorType(params: {
    text: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    await bridge.type(params.text, { device: params.device ?? params.emulator, worktreeId })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorButton(params: {
    name: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    await bridge.button(params.name, { device: params.device ?? params.emulator, worktreeId })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorRotate(params: {
    orientation: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    await bridge.rotate(params.orientation, {
      device: params.device ?? params.emulator,
      worktreeId
    })
    return RuntimeEmulatorCommands.OK
  }

  async emulatorExec(params: {
    command: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<unknown> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    return bridge.exec(params.command, {
      device: params.device,
      emulator: params.emulator,
      worktreeId
    })
  }

  async emulatorAttach(params: {
    device?: string
    worktree?: string
    focus?: boolean
  }): Promise<{ attached: boolean; info?: EmulatorSessionInfo }> {
    const settings = this.host.getSettings()
    if (settings.mobileEmulatorEnabled === false) {
      throw new EmulatorError('emulator_disabled', emulatorFailureText('disabled'))
    }
    const bridge = this.requireEmulatorBridge()
    let device = params.device ?? settings.mobileEmulatorDefaultDeviceUdid ?? undefined
    if (!device) {
      device = await resolveDefaultAttachDevice(bridge)
    }
    if (!device) {
      throw new EmulatorError('emulator_device_not_found', emulatorFailureText('noDeviceSpecified'))
    }
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    if (worktreeId) {
      const reusable = await bridge.getReusableActiveForWorktree(worktreeId, device)
      if (reusable) {
        // Renderer remounts must reuse streams to avoid disconnected reload loops.
        this.notifyRendererEmulatorAutoAttach(worktreeId, reusable)
        if (params.focus) {
          this.notifyRendererEmulatorPaneFocus(worktreeId)
        }
        return { attached: true, info: reusable }
      }
      // Device switch retains slow-boot Android emulators for fast switch-back.
      await bridge.stopActiveForSwitch(worktreeId)
    }
    const lease = await bridge.acquireHelperForDevice(device)
    const { info } = lease
    if (worktreeId) {
      try {
        const currentWorktreeId = await this.resolveWorktreeId(params.worktree)
        if (currentWorktreeId !== worktreeId) {
          throw new EmulatorError('emulator_no_active', emulatorFailureText('workspaceChanged'))
        }
      } catch (error) {
        // Workspaces can disappear during slow Android boots; release their lease.
        await lease.release({ cleanupIfUnused: true }).catch(() => {})
        if (error instanceof Error && error.message === 'selector_not_found') {
          throw new EmulatorError('emulator_no_active', emulatorFailureText('workspaceChanged'))
        }
        throw error
      }
      bridge.registerActiveEmulator(worktreeId, info, { managed: true })
      await lease.release()
      this.notifyRendererEmulatorAutoAttach(worktreeId, info)
      if (params.focus) {
        this.notifyRendererEmulatorPaneFocus(worktreeId)
      }
    } else {
      await lease.release()
    }
    return { attached: true, info }
  }

  async emulatorList(_params: { worktree?: string } = {}): Promise<unknown> {
    const bridge = this.requireEmulatorBridge()
    return bridge.listRunningHelpers()
  }

  async emulatorUnregisterActive(params: { worktree?: string }): Promise<{ ok: true }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveCleanupWorktreeId(params.worktree)
    if (worktreeId) {
      bridge.unregisterActiveEmulator(worktreeId)
    }
    return RuntimeEmulatorCommands.OK
  }

  async emulatorListSimulators(_params: { worktree?: string } = {}): Promise<SimulatorDevice[]> {
    // Include shutdown simulators so pane auto-start can choose/boot one; devices are host-local.
    const bridge = this.requireEmulatorBridge()
    return bridge.listSimulators()
  }

  async emulatorAvailability(_params: { worktree?: string } = {}): Promise<EmulatorAvailability> {
    return inspectEmulatorAvailability(this.requireEmulatorBridge())
  }

  async emulatorListDevices(_params: { worktree?: string } = {}): Promise<EmulatorDevice[]> {
    return this.requireEmulatorBridge().listAllDevices()
  }

  private async resolveWorktreeId(worktree?: string): Promise<string | undefined> {
    return worktree ? await this.host.resolveEmulatorWorkspaceId(worktree) : undefined
  }

  private async resolveCleanupWorktreeId(worktree?: string): Promise<string | undefined> {
    return worktree ? await this.host.resolveEmulatorCleanupWorkspaceId(worktree) : undefined
  }

  async emulatorInstall(
    params: EmulatorTargetParams & { path: string; reinstall?: boolean }
  ): Promise<{ ok: true }> {
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    await this.requireEmulatorBridge().runCapability(
      'install',
      { device: params.device ?? params.emulator, worktreeId },
      (backend, device) => backend.installApp!(device, params.path, { reinstall: params.reinstall })
    )
    return RuntimeEmulatorCommands.OK
  }

  async emulatorLaunch(
    params: EmulatorTargetParams & { package: string; activity?: string }
  ): Promise<{ ok: true }> {
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    await this.requireEmulatorBridge().runCapability(
      'launch',
      { device: params.device ?? params.emulator, worktreeId },
      (backend, device) => backend.launchApp!(device, params.package, params.activity)
    )
    return RuntimeEmulatorCommands.OK
  }

  async emulatorPermissions(
    params: EmulatorTargetParams & {
      op: 'grant' | 'revoke' | 'reset'
      package?: string
      permission?: string
    }
  ): Promise<{ ok: true }> {
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    await this.requireEmulatorBridge().runCapability(
      'permissions',
      { device: params.device ?? params.emulator, worktreeId },
      (backend, device) =>
        backend.setPermission!(device, params.op, params.package ?? '', params.permission)
    )
    return RuntimeEmulatorCommands.OK
  }

  async emulatorAx(params: EmulatorTargetParams): Promise<unknown> {
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    return this.requireEmulatorBridge().accessibilityTree({
      device: params.device ?? params.emulator,
      worktreeId
    })
  }

  async emulatorLogcat(
    params: EmulatorTargetParams & { lines?: number; filters?: string[] }
  ): Promise<unknown> {
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    return this.requireEmulatorBridge().runCapability(
      'logcat',
      { device: params.device ?? params.emulator, worktreeId },
      (backend, device) => backend.logcat!(device, { lines: params.lines, filters: params.filters })
    )
  }

  async emulatorKill(params: {
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<{ ok: true; deviceUdid: string }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveCleanupWorktreeId(params.worktree)
    const killedUdid = await bridge.kill(params.device ?? params.emulator, worktreeId)
    return { ok: true, deviceUdid: killedUdid }
  }

  async emulatorShutdown(params: {
    device?: string
    emulator?: string
    worktree?: string
    managedOnly?: boolean
  }): Promise<{ ok: true; deviceUdid?: string }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveCleanupWorktreeId(params.worktree)
    if (params.managedOnly && worktreeId && !params.device && !params.emulator) {
      const shutdownUdid = await bridge.shutdownActiveManagedForWorktree(worktreeId)
      return { ok: true, deviceUdid: shutdownUdid ?? undefined }
    }
    const shutdownUdid = await bridge.shutdown(params.device ?? params.emulator, worktreeId)
    return { ok: true, deviceUdid: shutdownUdid }
  }

  // Shutdown may already have destroyed the window; send best-effort.
  private sendToRenderer(channel: string, payload: unknown): void {
    try {
      this.host.getAuthoritativeWindow().webContents.send(channel, payload)
    } catch {}
  }

  // Match browser pane focus: never navigate to a different workspace.
  private notifyRendererEmulatorPaneFocus(worktreeId: string): void {
    this.sendToRenderer('emulator:pane-focus', { worktreeId })
  }

  private notifyRendererEmulatorAutoAttach(worktreeId: string, info: EmulatorSessionInfo): void {
    this.sendToRenderer('ui:emulatorAutoAttach', { worktreeId, info })
  }

  async emulatorExecRaw(params: {
    command: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<unknown> {
    return this.emulatorExec(params)
  }
}
