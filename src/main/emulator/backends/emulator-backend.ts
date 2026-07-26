import type { EmulatorGesturePoint } from '../emulator-gesture-sender'
import type {
  EmulatorBackendKind,
  EmulatorSessionInfo,
  EmulatorStreamCodec
} from '../emulator-types'

export type { EmulatorBackendKind, EmulatorStreamCodec }

// A device exposed by a backend, normalized across iOS (simulator UDID) and
// Android (adb serial / AVD name). `id` is opaque and backend-resolved.
export type EmulatorDevice = {
  backend: EmulatorBackendKind
  id: string
  name: string
  state: 'shutdown' | 'booting' | 'booted'
  detail?: string
  isAvailable: boolean
}

// Which optional verbs a backend supports. The router uses these to reject
// unsupported commands with a clear error instead of a silent no-op.
export type EmulatorBackendCapabilities = {
  install: boolean
  launch: boolean
  permissions: boolean
  accessibilityTree: boolean
  logcat: boolean
}

export type BackendAvailability = {
  available: boolean
  devices: EmulatorDevice[]
  message: string
  // Resolved toolchain root when found (e.g. the Android SDK path), for setup UI.
  sdkPath?: string
}

// Target selectors accepted by the router's public input methods.
export type EmulatorTargetOpts = {
  device?: string
  emulator?: string
  worktreeId?: string
}

// One emulator platform (iOS serve-sim today, Android scrcpy next). The
// EmulatorBridge router owns the session registry and per-worktree active
// state; a backend owns only device/helper/input mechanics for its platform.
// All device-facing methods take an opaque device id/selector that the backend
// resolves to its native id via resolveDeviceId.
export type EmulatorBackend = {
  readonly kind: EmulatorBackendKind
  readonly streamCodec: EmulatorStreamCodec
  readonly capabilities: EmulatorBackendCapabilities

  isSupportedOnHost(): boolean
  checkAvailability(): Promise<BackendAvailability>
  listDevices(): Promise<EmulatorDevice[]>
  ownsDevice(id: string): Promise<boolean>
  resolveDeviceId(deviceOrName: string): Promise<string>

  // Start (booting if needed) the helper/stream for a device and return its session.
  startSession(deviceId: string): Promise<EmulatorSessionInfo>
  // Stop the helper for a device without powering it off.
  stopHelperForDevice(
    deviceId: string,
    options?: { helperPid?: number; includeOrphaned?: boolean }
  ): Promise<void>
  // Power off the underlying device/AVD.
  shutdownDevice(deviceId: string): Promise<void>
  // Whether an active session can be reused (stream reachable + helper alive).
  isSessionReusable(info: EmulatorSessionInfo): Promise<boolean>

  tap(deviceId: string, x: number, y: number): Promise<void>
  // wsUrl is the iOS gesture stream from the registry; Android backends ignore it
  // and drive their own control socket keyed by deviceId.
  gesture(deviceId: string, points: EmulatorGesturePoint[], wsUrl: string | null): Promise<void>
  type(deviceId: string, text: string): Promise<void>
  button(deviceId: string, name: string): Promise<void>
  rotate(deviceId: string, orientation: string): Promise<void>
  exec(deviceId: string, command: string): Promise<unknown>

  // Capability-gated verbs. The router checks `capabilities`
  // before calling these and rejects unsupported backends with emulator_unsupported.
  installApp?(deviceId: string, apkPath: string, options?: { reinstall?: boolean }): Promise<void>
  launchApp?(deviceId: string, packageName: string, activity?: string): Promise<void>
  setPermission?(
    deviceId: string,
    op: 'grant' | 'revoke' | 'reset',
    packageName: string,
    permission?: string
  ): Promise<void>
  accessibilityTree?(deviceId: string, axUrl?: string): Promise<unknown>
  logcat?(
    deviceId: string,
    options?: { lines?: number; filters?: readonly string[] }
  ): Promise<unknown>
}
