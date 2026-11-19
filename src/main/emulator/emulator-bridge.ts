import { platform } from 'node:os'
import { EmulatorError } from './emulator-errors'
import type { EmulatorActiveSession, EmulatorSessionInfo } from './emulator-types'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { EmulatorBridgeOptions } from './emulator-bridge-types'
import type { EmulatorGesturePoint } from './emulator-gesture-sender'
import { EmulatorSessionRegistry } from './emulator-session-registry'
import { censusCleanup, destroySessions, reusableForWorkspace } from './emulator-session-cleanup'
import { stopForSwitch, stopTargetSession, stopWorkspaceSession } from './emulator-session-cleanup'
import { EmulatorStartLeaseRegistry } from './emulator-start-lease-registry'
import type { EmulatorStartLease } from './emulator-start-lease-registry'
import { listAvailableEmulatorDevices } from './emulator-device-inventory'
import { deriveAxUrlFromStreamUrl } from './serve-sim-detached-session'
import { IosEmulatorBackend } from './backends/ios-emulator-backend'
import { AndroidEmulatorBackend } from './backends/android-emulator-backend'
import type {
  EmulatorBackend,
  EmulatorBackendCapabilities,
  EmulatorBackendKind,
  EmulatorDevice,
  EmulatorTargetOpts
} from './backends/emulator-backend'

export class EmulatorBridge {
  private readonly sessionRegistry = new EmulatorSessionRegistry()
  private readonly startLeases = new EmulatorStartLeaseRegistry()
  private readonly cleanupCensus = censusCleanup(this.sessionRegistry, this.startLeases, (kind) =>
    this.backendForKind(kind)
  )
  private readonly backends: EmulatorBackend[]
  private readonly iosBackend: IosEmulatorBackend
  private readonly androidBackend: AndroidEmulatorBackend

  constructor(options: EmulatorBridgeOptions = {}) {
    this.iosBackend = new IosEmulatorBackend(options)
    this.androidBackend = new AndroidEmulatorBackend()
    // Register all backends so explicit targets reach their own host-support errors.
    this.backends = [this.iosBackend, this.androidBackend]
  }

  assertEmulatorOpen = (): void => this.startLeases.assertOpen()

  listBackends(): EmulatorBackend[] {
    return this.backends
  }

  async listAllDevices(): Promise<EmulatorDevice[]> {
    return listAvailableEmulatorDevices(this.backends)
  }

  async listSimulators(): Promise<SimulatorDevice[]> {
    return this.iosBackend.listSimulators()
  }

  async listActiveSessions(worktreeId?: string): Promise<EmulatorActiveSession[]> {
    return this.sessionRegistry.listLiveActive(
      worktreeId,
      (kind) => this.backendForKind(kind),
      this.cleanupCensus
    )
  }

  async checkServeSimAvailable(): Promise<void> {
    return this.iosBackend.checkServeSimAvailable()
  }

  registerActiveEmulator(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options: { managed?: boolean; backend?: EmulatorBackendKind } = {}
  ): string[] {
    return this.sessionRegistry.registerActive(worktreeId, info, options)
  }

  emulatorGeneration(deviceUdid: string): object | undefined {
    return this.sessionRegistry.generationForDevice(deviceUdid)
  }

  isCurrentEmulatorOwner(
    worktreeId: string,
    deviceUdid: string,
    generation: object | undefined
  ): boolean {
    return this.sessionRegistry.isCurrentOwner(worktreeId, deviceUdid, generation)
  }

  unregisterActiveEmulator(worktreeId: string): void {
    this.sessionRegistry.unregisterWorktree(worktreeId)
  }

  getActiveForWorktree(worktreeId?: string): EmulatorSessionInfo | null {
    return this.sessionRegistry.getActiveForWorktree(worktreeId)
  }

  // Keep slow-booting Android devices alive across switches for fast reattachment.
  async stopActiveForSwitch(
    worktreeId: string,
    assertCurrent?: () => void
  ): Promise<string | null> {
    return stopForSwitch(
      this,
      this.sessionRegistry,
      worktreeId,
      (shutdownDevice) => this.stopActiveForWorktreeInternal(worktreeId, { shutdownDevice }),
      assertCurrent
    )
  }

  async getReusableActiveForWorktree(
    worktreeId: string,
    device?: string
  ): Promise<EmulatorSessionInfo | null> {
    return reusableForWorkspace(
      this.sessionRegistry,
      (kind) => this.backendForKind(kind),
      worktreeId,
      device
    )
  }

  async isOwnedSessionReusable(info: EmulatorSessionInfo): Promise<boolean> {
    return (await this.backendForKind(info.backend ?? 'ios')?.isSessionReusable(info)) ?? false
  }

  async stopActiveForWorktree(
    worktreeId: string,
    options: { shutdownDevice?: boolean } = {}
  ): Promise<string | null> {
    return this.stopActiveForWorktreeInternal(worktreeId, options)
  }

  async stopActiveManagedForWorktree(
    worktreeId: string,
    options: { shutdownDevice?: boolean } = {}
  ): Promise<string | null> {
    return this.stopActiveForWorktreeInternal(worktreeId, { ...options, managedOnly: true })
  }

  private async stopActiveForWorktreeInternal(
    worktreeId: string,
    options: { shutdownDevice?: boolean; managedOnly?: boolean } = {}
  ): Promise<string | null> {
    return stopWorkspaceSession(
      this.sessionRegistry,
      this.startLeases,
      (kind) => this.backendForKind(kind),
      worktreeId,
      options
    )
  }

  async shutdownActiveManagedForWorktree(worktreeId: string): Promise<string | null> {
    return this.stopActiveManagedForWorktree(worktreeId, { shutdownDevice: true })
  }

  async tap(x: number, y: number, opts?: EmulatorTargetOpts): Promise<void> {
    const { backend, device } = await this.resolveTarget(opts)
    await backend.tap(device, x, y)
  }

  async gesture(points: EmulatorGesturePoint[], opts?: EmulatorTargetOpts): Promise<void> {
    if (points.length === 0) {
      return
    }
    const { backend, device } = await this.resolveTarget(opts)
    const udid = await backend.resolveDeviceId(device)
    const wsUrl = this.sessionRegistry.getSession(udid)?.wsUrl ?? null
    await backend.gesture(udid, points, wsUrl)
  }

  async type(text: string, opts?: EmulatorTargetOpts): Promise<void> {
    const { backend, device } = await this.resolveTarget(opts)
    await backend.type(device, text)
  }

  async button(name: string, opts?: EmulatorTargetOpts): Promise<void> {
    const { backend, device } = await this.resolveTarget(opts)
    await backend.button(device, name)
  }

  async rotate(orientation: string, opts?: EmulatorTargetOpts): Promise<void> {
    const { backend, device } = await this.resolveTarget(opts)
    await backend.rotate(device, orientation)
  }

  async exec(command: string, opts?: EmulatorTargetOpts): Promise<unknown> {
    const { backend, device } = await this.resolveTarget(opts)
    return backend.exec(device, command)
  }

  async accessibilityTree(opts?: EmulatorTargetOpts): Promise<unknown> {
    return this.runCapability('accessibilityTree', opts, async (backend, device) => {
      if (backend.kind !== 'ios') {
        return backend.accessibilityTree!(device)
      }
      const udid = await backend.resolveDeviceId(device)
      const worktreeId = opts?.worktreeId
      // Explicit device reads must work without an active workspace attachment.
      const session =
        (worktreeId ? this.getActiveForWorktree(worktreeId) : null) ??
        this.sessionRegistry.getSession(udid)
      if (worktreeId && session && session.deviceUdid !== udid) {
        throw new EmulatorError(
          'emulator_no_active',
          `iOS simulator ${udid} is not active for this worktree (active: ${session.deviceUdid}); attach the requested simulator first.`
        )
      }
      // Older registered sessions may lack the AX URL derived for fresh sessions.
      const axUrl = session?.axUrl ?? deriveAxUrlFromStreamUrl(session?.streamUrl)
      return backend.accessibilityTree!(udid, axUrl)
    })
  }

  /** Renderers name only a device; main resolves its registered helper so they cannot pick hosts. */
  getIosVideoStreamUrl(deviceUdid: string): string | null {
    return this.sessionRegistry.getIosVideoStreamUrl(deviceUdid)
  }

  async runCapability<T>(
    capability: keyof EmulatorBackendCapabilities,
    opts: EmulatorTargetOpts | undefined,
    run: (backend: EmulatorBackend, deviceId: string) => Promise<T>
  ): Promise<T> {
    const { backend, device } = await this.resolveTarget(opts)
    if (!backend.capabilities[capability]) {
      throw new EmulatorError(
        'emulator_unsupported',
        `${capability} is not supported by the ${backend.kind} emulator backend`
      )
    }
    return run(backend, device)
  }

  async acquireHelperForDevice(device: string): Promise<EmulatorStartLease> {
    const backend = await this.backendForDevice(device)
    return this.startLeases.acquire(backend, device, (info) =>
      this.sessionRegistry.hasActiveWorktreeForSession(info.deviceUdid)
    )
  }

  async kill(device?: string, worktreeId?: string): Promise<string> {
    return this.stopTarget(device, worktreeId, false)
  }

  async shutdown(device?: string, worktreeId?: string): Promise<string> {
    return this.stopTarget(device, worktreeId, true)
  }

  private async stopTarget(
    device: string | undefined,
    worktreeId: string | undefined,
    shutdown: boolean
  ): Promise<string> {
    if (!device && worktreeId) {
      const stopped = await this.stopActiveForWorktree(worktreeId, { shutdownDevice: shutdown })
      if (!stopped) {
        throw new EmulatorError(
          'emulator_no_active',
          'No active emulator for this worktree — use orca emulator attach or open the pane'
        )
      }
      return stopped
    }
    const { backend, device: targetDevice } = await this.resolveTarget({ device, worktreeId })
    const udid = await backend.resolveDeviceId(targetDevice)
    return stopTargetSession(this.sessionRegistry, this.startLeases, backend, udid, shutdown)
  }

  hasLiveManagedSessions(): Promise<boolean> {
    return this.sessionRegistry.pruneGoneManagedSessions(
      (kind) => this.backendForKind(kind),
      this.cleanupCensus
    )
  }

  destroyAllSessions(options?: { deadline?: number; signal?: AbortSignal }): Promise<void> {
    return destroySessions(
      this.sessionRegistry,
      this.startLeases,
      (kind) => this.backendForKind(kind),
      this.backends,
      options
    )
  }

  private async resolveTarget(
    opts?: EmulatorTargetOpts
  ): Promise<{ backend: EmulatorBackend; device: string }> {
    const explicit = opts?.device ?? opts?.emulator
    if (explicit) {
      return { backend: await this.backendForDevice(explicit), device: explicit }
    }
    if (opts?.worktreeId) {
      const active = this.getActiveForWorktree(opts.worktreeId)
      const backend = this.backendForActiveWorktree(opts.worktreeId)
      if (active && backend) {
        return { backend, device: active.deviceUdid }
      }
    }
    throw new EmulatorError(
      'emulator_no_active',
      'No active emulator for this worktree — use orca emulator attach or open the pane'
    )
  }

  private backendForKind(kind: EmulatorBackendKind): EmulatorBackend | null {
    return this.backends.find((backend) => backend.kind === kind) ?? null
  }

  private backendForActiveWorktree(worktreeId: string): EmulatorBackend | null {
    const key = this.sessionRegistry.getActiveSessionKey(worktreeId)
    const session = key ? this.sessionRegistry.getSession(key) : undefined
    return session ? this.backendForKind(session.backend) : null
  }

  private async backendForDevice(device: string): Promise<EmulatorBackend> {
    const registered = this.sessionRegistry.getSession(device)
    for (const backend of this.backends) {
      if (registered ? backend.kind === registered.backend : await backend.ownsDevice(device)) {
        return backend
      }
    }
    // Choose the host's backend so unknown devices produce the relevant setup error.
    return (
      this.backends.find((backend) => backend.isSupportedOnHost()) ??
      (platform() === 'darwin' ? this.iosBackend : this.androidBackend)
    )
  }
}
