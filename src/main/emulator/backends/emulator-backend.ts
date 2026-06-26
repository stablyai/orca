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
}

export type EmulatorTargetOpts = {
  device?: string
  emulator?: string
  worktreeId?: string
}

// One emulator platform (iOS serve-sim today, Android scrcpy next). The
// EmulatorBridge router owns the session registry and per-worktree active state;
// a backend owns only device/helper/input mechanics for its platform.
export type EmulatorBackend = {
  readonly kind: EmulatorBackendKind
  readonly streamCodec: EmulatorStreamCodec
  readonly capabilities: EmulatorBackendCapabilities

  isSupportedOnHost(): boolean
  checkAvailability(): Promise<BackendAvailability>
  listDevices(): Promise<EmulatorDevice[]>
  // True when this backend recognizes/owns the given opaque device id.
  ownsDevice(id: string): Promise<boolean>

  // Start (booting if needed) the helper/stream for a device and return its session.
  startSession(deviceId: string): Promise<EmulatorSessionInfo>

  tap(x: number, y: number, opts?: EmulatorTargetOpts): Promise<void>
  gesture(points: EmulatorGesturePoint[], opts?: EmulatorTargetOpts): Promise<void>
  type(text: string, opts?: EmulatorTargetOpts): Promise<void>
  button(name: string, opts?: EmulatorTargetOpts): Promise<void>
  rotate(orientation: string, opts?: EmulatorTargetOpts): Promise<void>
  exec(command: string, opts?: EmulatorTargetOpts): Promise<unknown>

  // Stop the helper for a device without powering it off.
  stopHelperForDevice(
    deviceId: string,
    options?: { helperPid?: number; includeOrphaned?: boolean }
  ): Promise<void>
  // Power off the underlying device/AVD.
  shutdownDevice(deviceId: string): Promise<void>
  // Resolve a user-supplied device name/selector to the opaque id this backend keys on.
  resolveDeviceId(deviceOrName: string): Promise<string>
  // Whether a live helper process exists for the session (used to decide reuse).
  hasHelperForSession(info: EmulatorSessionInfo): Promise<boolean>
}
