import { platform } from 'node:os'
import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionInfo } from './emulator-types'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { EmulatorBridgeOptions } from './emulator-bridge-types'
import type { EmulatorGesturePoint } from './emulator-gesture-sender'
import { EmulatorSessionRegistry } from './emulator-session-registry'
import { deriveServeSimAxUrl } from './serve-sim-detached-session'
import { IosEmulatorBackend } from './backends/ios-emulator-backend'
import { AndroidEmulatorBackend } from './backends/android-emulator-backend'
import type {
  EmulatorBackend,
  EmulatorBackendCapabilities,
  EmulatorBackendKind,
  EmulatorDevice,
  EmulatorTargetOpts
} from './backends/emulator-backend'

// Routes emulator commands to the backend that owns the target device while
// owning the per-worktree active-session registry and lifecycle orchestration.
// Backends supply only device/helper/input mechanics; the bridge decides which
// backend a command targets (by the session's recorded backend, else by device).
export class EmulatorBridge {
  private readonly sessionRegistry = new EmulatorSessionRegistry()
  private readonly backends: EmulatorBackend[]
  private readonly iosBackend: IosEmulatorBackend
  private readonly androidBackend: AndroidEmulatorBackend

  constructor(options: EmulatorBridgeOptions = {}) {
    this.iosBackend = new IosEmulatorBackend(options)
    this.androidBackend = new AndroidEmulatorBackend()
    // Why: backends are always registered (not host-gated) so explicitly targeted
    // commands still reach them; availability reporting handles host support.
    this.backends = [this.iosBackend, this.androidBackend]
  }

  listBackends(): EmulatorBackend[] {
    return this.backends
  }

  // Aggregated device list across host-supported backends (iOS simulators +
  // Android devices/AVDs), for the unified `orca emulator list`.
  async listAllDevices(): Promise<EmulatorDevice[]> {
    const perBackend = await Promise.all(
      this.backends.map(async (backend) => {
        if (!backend.isSupportedOnHost()) {
          return []
        }
        try {
          return await backend.listDevices()
        } catch {
          return []
        }
      })
    )
    return perBackend.flat()
  }

  // iOS-specific passthroughs kept for back-compat with the runtime + availability code.
  async listSimulators(): Promise<SimulatorDevice[]> {
    return this.iosBackend.listSimulators()
  }

  async listRunningHelpers(): Promise<unknown> {
    return this.iosBackend.listRunningHelpers()
  }

  async checkServeSimAvailable(): Promise<void> {
    return this.iosBackend.checkServeSimAvailable()
  }

  registerActiveEmulator(
    worktreeId: string,
    info: EmulatorSessionInfo,
    options: { managed?: boolean; backend?: EmulatorBackendKind } = {}
  ): void {
    this.sessionRegistry.registerActive(worktreeId, info, options)
  }

  unregisterActiveEmulator(worktreeId: string): void {
    this.sessionRegistry.unregisterWorktree(worktreeId)
  }

  getActiveForWorktree(worktreeId?: string): EmulatorSessionInfo | null {
    return this.sessionRegistry.getActiveForWorktree(worktreeId)
  }

  getActiveBackendKind(worktreeId: string): EmulatorBackendKind | null {
    return this.backendForActiveWorktree(worktreeId)?.kind ?? null
  }

  // On a device switch, keep slow-to-boot Android emulators running for instant
  // switch-back; shut down other backends' devices so they are not leaked.
  async stopActiveForSwitch(worktreeId: string): Promise<string | null> {
    const keepAlive = this.getActiveBackendKind(worktreeId) === 'android'
    return this.stopActiveForWorktreeInternal(worktreeId, { shutdownDevice: !keepAlive })
  }

  async getReusableActiveForWorktree(
    worktreeId: string,
    device?: string
  ): Promise<EmulatorSessionInfo | null> {
    const active = this.getActiveForWorktree(worktreeId)
    if (!active) {
      return null
    }
    const backend = this.backendForActiveWorktree(worktreeId)
    if (!backend) {
      return null
    }
    if (device) {
      // resolveDeviceId throws for a not-yet-booted AVD; treat that as "not the
      // active device" so the caller falls through to a fresh (booting) attach.
      const resolved = await backend.resolveDeviceId(device).catch(() => null)
      if (resolved !== active.deviceUdid) {
        return null
      }
    }
    return (await backend.isSessionReusable(active)) ? active : null
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
    const key = this.sessionRegistry.getActiveSessionKey(worktreeId)
    if (!key) {
      return null
    }
    const session = this.sessionRegistry.getSession(key)
    this.sessionRegistry.unregisterWorktree(worktreeId)
    if (!session || (options.managedOnly && !session.managed)) {
      return null
    }
    const backend = this.backendForKind(session.backend)
    if (!backend) {
      return null
    }
    await backend.stopHelperForDevice(session.deviceUdid, {
      helperPid: session.pid,
      includeOrphaned: !options.managedOnly
    })
    if (options.shutdownDevice) {
      await backend.shutdownDevice(session.deviceUdid).catch(() => {})
    }
    this.sessionRegistry.clearSessionAndWorktrees(key)
    return session.deviceUdid
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
      const udid = await backend.resolveDeviceId(device)
      const session = this.sessionRegistry.getSession(udid)
      // Fallback heals sessions registered without axUrl (e.g. renderer-supplied
      // info that predates ax derivation); Android backends ignore the argument.
      const axUrl = session?.axUrl ?? deriveServeSimAxUrl(session?.streamUrl) ?? null
      return backend.accessibilityTree!(udid, axUrl)
    })
  }

  // Runs a capability-gated verb against the resolved target, rejecting backends
  // that do not advertise the capability (e.g. install/logcat on iOS).
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

  async startHelperForDevice(device: string): Promise<EmulatorSessionInfo> {
    const backend = await this.backendForDevice(device)
    return backend.startSession(device)
  }

  async kill(device?: string, worktreeId?: string): Promise<string> {
    const { backend, udid } = await this.resolveStopTarget(device, worktreeId)
    await backend.stopHelperForDevice(udid, {
      helperPid: this.sessionRegistry.getSession(udid)?.pid,
      includeOrphaned: true
    })
    this.sessionRegistry.clearSessionAndWorktrees(udid)
    return udid
  }

  async shutdown(device?: string, worktreeId?: string): Promise<string> {
    const { backend, udid } = await this.resolveStopTarget(device, worktreeId)
    await backend.stopHelperForDevice(udid, {
      helperPid: this.sessionRegistry.getSession(udid)?.pid,
      includeOrphaned: true
    })
    await backend.shutdownDevice(udid)
    this.sessionRegistry.clearSessionAndWorktrees(udid)
    return udid
  }

  async destroyAllSessions(): Promise<void> {
    const promises: Promise<unknown>[] = []
    for (const session of this.sessionRegistry.listSessions()) {
      if (!session.managed) {
        continue
      }
      const backend = this.backendForKind(session.backend)
      if (!backend) {
        continue
      }
      promises.push(
        backend
          .stopHelperForDevice(session.deviceUdid, { helperPid: session.pid })
          .catch(() => {})
          .then(() => backend.shutdownDevice(session.deviceUdid).catch(() => {}))
      )
    }
    await Promise.allSettled(promises)
    this.sessionRegistry.clear()
  }

  async onAppQuit(): Promise<void> {
    await this.destroyAllSessions()
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

  private async resolveStopTarget(
    device?: string,
    worktreeId?: string
  ): Promise<{ backend: EmulatorBackend; udid: string }> {
    if (device) {
      const backend = await this.backendForDevice(device)
      return { backend, udid: await backend.resolveDeviceId(device) }
    }
    const { backend, device: resolved } = await this.resolveTarget({ worktreeId })
    return { backend, udid: await backend.resolveDeviceId(resolved) }
  }

  private backendForKind(kind: EmulatorBackendKind): EmulatorBackend | null {
    return this.backends.find((backend) => backend.kind === kind) ?? null
  }

  private backendForActiveWorktree(worktreeId: string): EmulatorBackend | null {
    const key = this.sessionRegistry.getActiveSessionKey(worktreeId)
    if (!key) {
      return null
    }
    const session = this.sessionRegistry.getSession(key)
    return session ? this.backendForKind(session.backend) : null
  }

  private async backendForDevice(device: string): Promise<EmulatorBackend> {
    for (const backend of this.backends) {
      if (await backend.ownsDevice(device)) {
        return backend
      }
    }
    // Why: fall back to a host-supported backend, else the platform-primary one,
    // so an unrecognized device (e.g. no SDK yet) surfaces the right setup error
    // — Android on Windows/Linux, iOS/CoreSimulator on macOS — not iOS-on-Windows.
    return (
      this.backends.find((backend) => backend.isSupportedOnHost()) ??
      (platform() === 'darwin' ? this.iosBackend : this.androidBackend)
    )
  }
}
