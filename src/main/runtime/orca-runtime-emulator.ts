import type { BrowserWindow } from 'electron'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { EmulatorError } from '../emulator/emulator-errors'
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
import type { GlobalSettings } from '../../shared/types'

// Settings slice the emulator surface needs; keeps the host contract honest (no widening cast).
type EmulatorHostSettings = Pick<
  GlobalSettings,
  'mobileEmulatorEnabled' | 'mobileEmulatorDefaultDeviceUdid' | 'androidSdkPath'
>

// Why: dedicated file for "one surface" separation (emulator), parallel to orca-runtime-browser.ts. Keeps OrcaRuntimeService focused; emulator routing easy to scan. No max-lines disable (split further if grows; per AGENTS + plan Phase 3).
export type RuntimeEmulatorCommandHost = {
  getEmulatorBridge(): EmulatorBridge | null
  resolveWorktreeSelector(selector: string): Promise<{ id: string }>
  getAuthoritativeWindow(): BrowserWindow
  getSettings(): EmulatorHostSettings
}

type EmulatorTargetParams = { device?: string; emulator?: string; worktree?: string }

export class RuntimeEmulatorCommands {
  constructor(private readonly host: RuntimeEmulatorCommandHost) {}

  private requireEmulatorBridge(): EmulatorBridge {
    const bridge = this.host.getEmulatorBridge()
    if (!bridge) {
      throw new EmulatorError('emulator_no_active', 'No emulator session is active')
    }
    // Honor the user's configured Android SDK path before the backend resolves it.
    setConfiguredAndroidSdkPath(this.host.getSettings().androidSdkPath ?? null)
    return bridge
  }

  // Why: RPC envelopes require a serializable `result` field; void/undefined omits it and breaks CLI schema validation.
  private static readonly OK = { ok: true as const }

  // High-level delegation (mirror browser* methods).
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
      throw new EmulatorError('emulator_disabled', 'Mobile Emulator is disabled in Settings.')
    }
    const bridge = this.requireEmulatorBridge()
    let device = params.device ?? settings.mobileEmulatorDefaultDeviceUdid ?? undefined
    if (!device) {
      device = await resolveDefaultAttachDevice(bridge)
    }
    if (!device) {
      throw new EmulatorError(
        'emulator_device_not_found',
        'No emulator device specified. Choose a default device in Settings > Mobile Emulator or pass a device.'
      )
    }
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    if (worktreeId) {
      const reusable = await bridge.getReusableActiveForWorktree(worktreeId, device)
      if (reusable) {
        // Why: renderer remounts should reconnect to the existing stream, not
        // kill it and create the stream-disconnected reload loop users see.
        this.notifyRendererEmulatorAutoAttach(worktreeId, reusable)
        if (params.focus) {
          this.notifyRendererEmulatorPaneFocus(worktreeId)
        }
        return { attached: true, info: reusable }
      }
      // A different requested device is an explicit switch; the bridge keeps a
      // slow-to-boot Android emulator alive for instant switch-back.
      await bridge.stopActiveForSwitch(worktreeId)
    }
    const info = await bridge.startHelperForDevice(device)
    if (worktreeId) {
      bridge.registerActiveEmulator(worktreeId, info, { managed: true })
      this.notifyRendererEmulatorAutoAttach(worktreeId, info)
      if (params.focus) {
        this.notifyRendererEmulatorPaneFocus(worktreeId)
      }
    }
    // Default: no auto steal (mirror browser tab create/switch). --focus sends emulator:pane-focus only when requested.
    return { attached: true, info }
  }

  async emulatorList(_params: { worktree?: string } = {}): Promise<unknown> {
    const bridge = this.requireEmulatorBridge()
    return bridge.listRunningHelpers()
  }

  async emulatorUnregisterActive(params: { worktree?: string }): Promise<{ ok: true }> {
    const bridge = this.requireEmulatorBridge()
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    if (worktreeId) {
      bridge.unregisterActiveEmulator(worktreeId)
    }
    return RuntimeEmulatorCommands.OK
  }

  async emulatorListSimulators(_params: { worktree?: string } = {}): Promise<SimulatorDevice[]> {
    // Why: exposed for the EmulatorPane auto-flow on "New Mobile Emulator" tab creation.
    // Returns the full simctl list (including Shutdown devices) so the pane can choose a default and
    // rely on startHelperForDevice + ensureDeviceBooted to boot if needed. Worktree param ignored
    // (simulators are host-local, not per-worktree).
    const bridge = this.requireEmulatorBridge()
    return bridge.listSimulators()
  }

  async emulatorAvailability(_params: { worktree?: string } = {}): Promise<EmulatorAvailability> {
    return inspectEmulatorAvailability(this.requireEmulatorBridge())
  }

  // Why: unified device inventory across backends (iOS simulators + Android
  // devices/AVDs) for the cross-platform `orca emulator devices` command.
  async emulatorListDevices(_params: { worktree?: string } = {}): Promise<EmulatorDevice[]> {
    return this.requireEmulatorBridge().listAllDevices()
  }

  private async resolveWorktreeId(worktree?: string): Promise<string | undefined> {
    return worktree ? (await this.host.resolveWorktreeSelector(worktree)).id : undefined
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
    const worktreeId = await this.resolveWorktreeId(params.worktree)
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
    const worktreeId = await this.resolveWorktreeId(params.worktree)
    if (params.managedOnly && worktreeId && !params.device && !params.emulator) {
      const shutdownUdid = await bridge.shutdownActiveManagedForWorktree(worktreeId)
      return { ok: true, deviceUdid: shutdownUdid ?? undefined }
    }
    const shutdownUdid = await bridge.shutdown(params.device ?? params.emulator, worktreeId)
    return { ok: true, deviceUdid: shutdownUdid }
  }

  // Window may not exist during shutdown, so sends are best-effort.
  private sendToRenderer(channel: string, payload: unknown): void {
    try {
      this.host.getAuthoritativeWindow().webContents.send(channel, payload)
    } catch {
      // Window may not exist during shutdown
    }
  }

  // Why: mirror browser:pane-focus — scoped per worktree, no cross-worktree yank unless user is already there.
  private notifyRendererEmulatorPaneFocus(worktreeId: string): void {
    this.sendToRenderer('emulator:pane-focus', { worktreeId })
  }

  private notifyRendererEmulatorAutoAttach(worktreeId: string, info: EmulatorSessionInfo): void {
    this.sendToRenderer('ui:emulatorAutoAttach', { worktreeId, info })
  }

  // Raw for extensibility.
  async emulatorExecRaw(params: {
    command: string
    device?: string
    emulator?: string
    worktree?: string
  }): Promise<unknown> {
    return this.emulatorExec(params)
  }
}

// Singleton accessor pattern (mirror requireAgentBrowserBridge).
let emulatorBridgeInstance: EmulatorBridge | null = null

export function setEmulatorBridge(bridge: EmulatorBridge | null): void {
  emulatorBridgeInstance = bridge
}

export function getEmulatorBridge(): EmulatorBridge | null {
  return emulatorBridgeInstance
}

export function requireEmulatorBridge(): EmulatorBridge {
  if (!emulatorBridgeInstance) {
    throw new EmulatorError('emulator_no_active', 'Emulator bridge not initialized')
  }
  return emulatorBridgeInstance
}
