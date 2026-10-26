import type { EmulatorGesturePoint } from '../emulator-gesture-sender'
import type {
  EmulatorBackendKind,
  EmulatorSessionInfo,
  EmulatorStreamCodec
} from '../emulator-types'

export type { EmulatorBackendKind, EmulatorStreamCodec }

// IDs are opaque selectors resolved by each backend (simulator UDID, adb serial, or AVD name).
export type EmulatorDevice = {
  backend: EmulatorBackendKind
  id: string
  name: string
  state: 'shutdown' | 'booting' | 'booted'
  detail?: string
  isAvailable: boolean
}

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
  sdkPath?: string
}

export type EmulatorTargetOpts = {
  device?: string
  emulator?: string
  worktreeId?: string
}

// The bridge owns active-workspace state; backends own device, helper, and input operations.
export type EmulatorBackend = {
  readonly kind: EmulatorBackendKind
  readonly streamCodec: EmulatorStreamCodec
  readonly capabilities: EmulatorBackendCapabilities

  isSupportedOnHost(): boolean
  checkAvailability(): Promise<BackendAvailability>
  listDevices(): Promise<EmulatorDevice[]>
  ownsDevice(id: string): Promise<boolean>
  resolveDeviceId(deviceOrName: string): Promise<string>

  startSession(deviceId: string): Promise<EmulatorSessionInfo>
  // Stop the helper for a device without powering it off.
  stopHelperForDevice(
    deviceId: string,
    options?: { helperPid?: number; includeOrphaned?: boolean }
  ): Promise<void>
  shutdownDevice(deviceId: string): Promise<void>
  isSessionReusable(info: EmulatorSessionInfo): Promise<boolean>

  tap(deviceId: string, x: number, y: number): Promise<void>
  // Android ignores the iOS gesture URL and uses its own device control channel.
  gesture(deviceId: string, points: EmulatorGesturePoint[], wsUrl: string | null): Promise<void>
  type(deviceId: string, text: string): Promise<void>
  button(deviceId: string, name: string): Promise<void>
  rotate(deviceId: string, orientation: string): Promise<void>
  exec(deviceId: string, command: string): Promise<unknown>

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
