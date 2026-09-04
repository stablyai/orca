import { platform } from 'node:os'
import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionInfo } from './emulator-types'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { EmulatorBridgeOptions } from './emulator-bridge-types'
import type { EmulatorGesturePoint } from './emulator-gesture-sender'
import { EmulatorSessionRegistry } from './emulator-session-registry'
import {
  EmulatorStartLeaseRegistry,
  type EmulatorStartLease
} from './emulator-start-lease-registry'
import { listAvailableEmulatorDevices } from './emulator-device-inventory'
import { deriveAxUrlFromStreamUrl } from './serve-sim-detached-session'
import { IosEmulatorBackend } from './backends/ios-emulator-backend'
import { AndroidEmulatorBackend } from './backends/android-emulator-backend'
import { isAdbNetworkSerial } from './android/adb-network-endpoint'
import type { AdbConnectionStatus } from './android/adb-device-connection'
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
  private readonly startLeases = new EmulatorStartLeaseRegistry()
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
    return listAvailableEmulatorDevices(this.backends)
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

  // Explicit ADB network device connect/status — the only initiator of `adb
  // connect` anywhere in the app (never called from availability/boot/pane-open).
  async adbConnect(address: string): Promise<AdbConnectionStatus> {
    return this.androidBackend.adbConnection.connect(address)
  }

  async adbConnectionStatus(address: string): Promise<AdbConnectionStatus> {
    return this.androidBackend.adbConnection.status(address)
  }

  // For RPC disconnect/status calls that don't name an address explicitly —
  // surfaces the manager's own address->serial mapping, no new state owned here.
  adbCurrentAddress(): string | null {
    return this.androidBackend.adbConnection.currentAddress()
  }

  // Explicit Disconnect lifecycle: stop this device's scrcpy helper (+ orphan
  // forwards) and drop it from the session registry BEFORE `adb disconnect`,
  // so no session is left pointing at a serial adb no longer recognizes.
  async adbDisconnect(address: string): Promise<AdbConnectionStatus> {
    const serial = this.androidBackend.adbConnection.serialFor(address) ?? address
    await this.androidBackend.stopHelperForDevice(serial, { includeOrphaned: true })
    this.sessionRegistry.clearSessionAndWorktrees(serial)
    return this.androidBackend.adbConnection.disconnect(address)
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

  // On a device switch, keep slow-to-boot Android emulators running for instant
  // switch-back; shut down other backends' devices so they are not leaked.
  async stopActiveForSwitch(worktreeId: string): Promise<string | null> {
    const keepAlive = this.backendForActiveWorktree(worktreeId)?.kind === 'android'
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
    if (this.sessionRegistry.hasActiveWorktreeForSession(key)) {
      return session.deviceUdid
    }
    const backend = this.backendForKind(session.backend)
    if (!backend) {
      return null
    }
    const sessionInfo = this.sessionRegistry.toSessionInfo(session)
    await this.startLeases.cleanupWhenIdle(
      backend,
      sessionInfo,
      (info) => this.sessionRegistry.hasActiveWorktreeForSession(info.deviceUdid),
      {
        includeOrphaned: !options.managedOnly,
        shutdownDevice: options.shutdownDevice
      }
    )
    if (!this.sessionRegistry.hasActiveWorktreeForSession(key)) {
      this.sessionRegistry.clearSessionAndWorktrees(key)
    }
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
      if (backend.kind !== 'ios') {
        return backend.accessibilityTree!(device)
      }
      const udid = await backend.resolveDeviceId(device)
      const worktreeId = opts?.worktreeId
      // Fall back to the udid-keyed session so an explicit --device read works
      // from a worktree with no active emulator (matching tap/type reachability);
      // sessions are stored once per udid, so both lookups hit the same state.
      const session =
        (worktreeId ? this.getActiveForWorktree(worktreeId) : null) ??
        this.sessionRegistry.getSession(udid)
      if (worktreeId && session && session.deviceUdid !== udid) {
        throw new EmulatorError(
          'emulator_no_active',
          `iOS simulator ${udid} is not active for this worktree (active: ${session.deviceUdid}); attach the requested simulator first.`
        )
      }
      // Heal sessions registered without an axUrl (parse-time derivation only
      // covers fresh --detach output) by deriving it from the mjpeg stream URL.
      const axUrl = session?.axUrl ?? deriveAxUrlFromStreamUrl(session?.streamUrl)
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

  async acquireHelperForDevice(device: string): Promise<EmulatorStartLease> {
    const backend = await this.backendForDevice(device)
    return this.startLeases.acquire(backend, device, (info) =>
      this.sessionRegistry.hasActiveWorktreeForSession(info.deviceUdid)
    )
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
    // An ADB TCP address (host:port) is unambiguously Android, even when it is
    // offline/unrecognized by any backend's ownsDevice — classify it before the
    // ownership loop so it never falls through to the iOS/host-platform fallback.
    if (isAdbNetworkSerial(device)) {
      return this.androidBackend
    }
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
