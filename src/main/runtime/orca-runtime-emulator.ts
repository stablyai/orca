import { emulatorDevicePreference } from '../emulator/emulator-opening-preference'
import type { BrowserWindow } from 'electron'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { EmulatorError } from '../emulator/emulator-errors'
import { emulatorFailureText } from '../../shared/emulator-failure-copy'
import {
  inspectEmulatorAvailability,
  type EmulatorAvailability
} from '../emulator/emulator-availability'
import { RuntimeEmulatorAttach, type RuntimeEmulatorAttachParams } from './runtime-emulator-attach'
import { setConfiguredAndroidSdkPath } from '../emulator/android/android-sdk-host-discovery'
import type { EmulatorGesturePoint } from '../emulator/emulator-gesture-sender'
import type { EmulatorSessionInfo } from '../emulator/emulator-types'
import type { SimulatorDevice } from '../emulator/simctl-simulator-devices'
import type { EmulatorDevice } from '../emulator/backends/emulator-backend'
import type { GlobalSettings } from '../../shared/global-settings-types'

type EmulatorHostSettings = Pick<
  GlobalSettings,
  | 'mobileEmulatorEnabled'
  | 'mobileEmulatorDefaultDeviceUdid'
  | 'androidSdkPath'
  | 'mobileEmulatorOpeningMode'
  | 'mobileEmulatorRecentDevices'
>

export type RuntimeEmulatorCommandHost = {
  getEmulatorBridge(): EmulatorBridge | null
  resolveEmulatorWorkspaceId(selector: string): Promise<string>
  resolveEmulatorCleanupWorkspaceId(selector: string): Promise<string>
  getAuthoritativeWindow(): BrowserWindow
  getSettings(): EmulatorHostSettings
  updateEmulatorSettings?(updates: Pick<GlobalSettings, 'mobileEmulatorRecentDevices'>): void
}

type EmulatorTargetParams = { device?: string; emulator?: string; worktree?: string }

export class RuntimeEmulatorCommands {
  private readonly attachCommands: RuntimeEmulatorAttach
  constructor(private readonly host: RuntimeEmulatorCommandHost) {
    this.attachCommands = new RuntimeEmulatorAttach(
      host,
      () => this.requireEmulatorBridge(),
      (worktreeId, info, focus) => {
        this.notifyRendererEmulatorAutoAttach(worktreeId, info)
        if (focus) {
          this.notifyRendererEmulatorPaneFocus(worktreeId)
        }
      }
    )
  }

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

  emulatorAttach(params: RuntimeEmulatorAttachParams) {
    return this.attachCommands.attach(params)
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
    const recent = this.host.getSettings().mobileEmulatorRecentDevices ?? []
    const devices = await this.requireEmulatorBridge().listAllDevices()
    return devices.map((device) => {
      const identity = emulatorDevicePreference(device)
      const remembered = recent.find(
        (item) =>
          item.backend === identity?.backend &&
          item.kind === identity.kind &&
          item.id === identity.id
      )
      return remembered && (!device.lastUsedAt || remembered.lastUsedAt > device.lastUsedAt)
        ? { ...device, lastUsedAt: remembered.lastUsedAt }
        : device
    })
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
