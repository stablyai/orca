import type { EmulatorSessionInfo } from '../emulator-types'
import type {
  BackendAvailability,
  EmulatorBackend,
  EmulatorBackendCapabilities,
  EmulatorDevice
} from './emulator-backend'
import type { HarmonyCommandRunner } from '../harmony/harmony-command-runner'
import type { HarmonySdkPaths } from '../harmony/harmony-sdk-discovery'
import { HarmonyDeviceController } from '../harmony/harmony-device-controller'
import { HarmonyStreamController } from '../harmony/harmony-stream-controller'
import {
  startHarmonyStreamSession,
  type StartHarmonyStream
} from '../harmony/harmony-stream-session-starter'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

export type HarmonyEmulatorBackendOptions = {
  runner?: HarmonyCommandRunner
  // Inject resolved toolchain (tests); undefined auto-discovers, null means none.
  sdk?: HarmonySdkPaths | null
  deployedRoots?: readonly string[]
  listDirectory?: (dir: string) => string[]
  bootTimeoutMs?: number
  pollIntervalMs?: number
  frameIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  startStreamSession?: StartHarmonyStream
}

// The HarmonyOS backend. Discovery/lifecycle/input live in the device
// controller; the live pane is MJPEG fed by periodic snapshots (the emulator
// exposes no video capture), managed by the stream controller.
export class HarmonyEmulatorBackend implements EmulatorBackend {
  readonly kind = 'harmonyos' as const
  readonly streamCodec = 'mjpeg' as const
  readonly capabilities: EmulatorBackendCapabilities = {
    install: true,
    launch: true,
    permissions: false,
    accessibilityTree: true,
    logcat: false
  }

  private readonly devices: HarmonyDeviceController
  private readonly streams: HarmonyStreamController

  constructor(options: HarmonyEmulatorBackendOptions = {}) {
    this.devices = new HarmonyDeviceController(options)
    this.streams = new HarmonyStreamController({
      startStreamSession: options.startStreamSession ?? startHarmonyStreamSession,
      runner: this.devices.commandRunner,
      sdk: () => this.devices.requireSdk(),
      frameIntervalMs: options.frameIntervalMs
    })
  }

  isSupportedOnHost(): boolean {
    return this.devices.isSupportedOnHost()
  }

  checkAvailability(): Promise<BackendAvailability> {
    return this.devices.checkAvailability()
  }

  listDevices(): Promise<EmulatorDevice[]> {
    return this.devices.listDevices()
  }

  ownsDevice(id: string): Promise<boolean> {
    return this.devices.ownsDevice(id)
  }

  resolveDeviceId(deviceOrName: string): Promise<string> {
    return this.devices.resolveDeviceId(deviceOrName)
  }

  async startSession(deviceId: string): Promise<EmulatorSessionInfo> {
    const connectKey = await this.devices.boot(deviceId)
    const info = await this.streams.start(connectKey)
    await this.devices.primeScreen(connectKey)
    return info
  }

  async stopHelperForDevice(deviceId: string): Promise<void> {
    const key = await this.resolveDeviceId(deviceId).catch(() => null)
    if (key) {
      this.streams.stop(key)
    }
  }

  async shutdownDevice(deviceId: string): Promise<void> {
    const connectKey = await this.resolveDeviceId(deviceId)
    this.streams.stop(connectKey)
    await this.devices.shutdown(connectKey)
  }

  isSessionReusable(info: EmulatorSessionInfo): Promise<boolean> {
    return Promise.resolve(this.streams.has(info.deviceUdid))
  }

  tap(deviceId: string, x: number, y: number): Promise<void> {
    return this.devices.tap(deviceId, x, y)
  }

  gesture(deviceId: string, points: EmulatorGesturePoint[], _wsUrl: string | null): Promise<void> {
    return this.devices.gesture(deviceId, points)
  }

  type(deviceId: string, text: string): Promise<void> {
    return this.devices.typeText(deviceId, text)
  }

  button(deviceId: string, name: string): Promise<void> {
    return this.devices.button(deviceId, name)
  }

  rotate(deviceId: string, orientation: string): Promise<void> {
    return this.devices.rotate(deviceId, orientation)
  }

  exec(deviceId: string, command: string): Promise<unknown> {
    return this.devices.exec(deviceId, command)
  }

  installApp(deviceId: string, appPath: string, options?: { reinstall?: boolean }): Promise<void> {
    return this.devices.installApp(deviceId, appPath, options)
  }

  launchApp(deviceId: string, bundleName: string, ability?: string): Promise<void> {
    return this.devices.launchApp(deviceId, bundleName, ability)
  }

  accessibilityTree(deviceId: string): Promise<unknown> {
    return this.devices.accessibilityTree(deviceId)
  }
}
