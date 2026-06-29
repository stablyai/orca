import { EmulatorError } from '../emulator-errors'
import type { EmulatorSessionInfo } from '../emulator-types'
import type {
  BackendAvailability,
  EmulatorBackend,
  EmulatorBackendCapabilities,
  EmulatorDevice
} from './emulator-backend'
import type { AndroidSdkPaths } from '../android/android-sdk-discovery'
import { AndroidSdkState } from '../android/android-sdk-state'
import { parseWmSize, wmSizeArgs } from '../android/adb-devices'
import { emuKillArgs } from '../android/avd-manager'
import type { DeviceScreenSize } from '../android/android-input-mapping'
import {
  androidButton,
  androidExec,
  androidRotate,
  androidSwipe,
  androidTap,
  androidTypeText
} from '../android/android-input-commands'
import {
  execFileAndroidCommandRunner,
  type AndroidCommandRunner
} from '../android/android-command-runner'
import { ensureAdbOk } from '../android/android-adb-result'
import {
  findRunningAvdSerial,
  listAndroidDevices,
  listRunningAdbDevices
} from '../android/android-device-inventory'
import {
  captureAndroidLogcat,
  dumpAndroidAccessibilityTree,
  installAndroidApk,
  launchAndroidApp,
  setAndroidPermission
} from '../android/android-capability-operations'
import type { AndroidPermissionOp } from '../android/android-permissions'
import { bootAndroidDevice } from '../android/android-avd-boot'
import { ensureScrcpyServerJar } from '../android/scrcpy-server-download'
import {
  startAndroidStreamSession,
  type StartAndroidStream
} from '../android/android-stream-session-starter'
import { AndroidStreamController } from '../android/android-stream-controller'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

export type AndroidEmulatorBackendOptions = {
  runner?: AndroidCommandRunner
  // Inject discovered SDK paths (tests); undefined means auto-discover, null means "no SDK".
  sdk?: AndroidSdkPaths | null
  bootTimeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  ensureJar?: () => Promise<string>
  startStreamSession?: StartAndroidStream
  streamMaxSize?: number
}

const DEFAULT_BOOT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

// The Android backend. Device discovery + lifecycle + input run through `adb`
// and the `emulator` binary; the live H.264 pane streams via scrcpy. Input uses
// `adb shell input`, so it works without sending on the scrcpy control socket.
export class AndroidEmulatorBackend implements EmulatorBackend {
  readonly kind = 'android' as const
  readonly streamCodec = 'h264' as const
  readonly capabilities: EmulatorBackendCapabilities = {
    install: true,
    launch: true,
    permissions: true,
    accessibilityTree: true,
    logcat: true
  }

  private readonly runner: AndroidCommandRunner
  private readonly sdkState: AndroidSdkState
  private readonly bootTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly ensureJar: () => Promise<string>
  private readonly startStreamSession: StartAndroidStream
  private readonly streamMaxSize: number
  private readonly screenSizes = new Map<string, DeviceScreenSize>()
  private readonly streams: AndroidStreamController

  constructor(options: AndroidEmulatorBackendOptions = {}) {
    this.runner = options.runner ?? execFileAndroidCommandRunner
    this.sdkState = new AndroidSdkState(options.sdk !== undefined, options.sdk ?? null)
    this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.sleep = options.sleep ?? defaultSleep
    this.ensureJar = options.ensureJar ?? ensureScrcpyServerJar
    this.startStreamSession = options.startStreamSession ?? startAndroidStreamSession
    this.streamMaxSize = options.streamMaxSize ?? 1280
    this.streams = new AndroidStreamController({
      runner: this.runner,
      sdk: () => this.requireSdk(),
      ensureJar: this.ensureJar,
      startStreamSession: this.startStreamSession,
      maxSize: this.streamMaxSize
    })
  }

  isSupportedOnHost(): boolean {
    return this.sdkState.resolve() !== null
  }

  async checkAvailability(): Promise<BackendAvailability> {
    const sdk = this.sdkState.resolve()
    if (!sdk) {
      return {
        available: false,
        devices: [],
        message: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'
      }
    }
    const sdkPath = sdk.sdkRoot
    let devices: EmulatorDevice[] = []
    try {
      devices = await this.listDevices()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'adb is unavailable.'
      return { available: false, devices: [], message, sdkPath }
    }
    if (devices.length === 0) {
      return {
        available: false,
        devices,
        message: 'No Android devices or AVDs found. Create one in Android Studio.',
        sdkPath
      }
    }
    return { available: true, devices, message: 'Ready', sdkPath }
  }

  async listDevices(): Promise<EmulatorDevice[]> {
    const sdk = this.sdkState.resolve()
    return sdk ? listAndroidDevices(this.runner, sdk) : []
  }

  async ownsDevice(id: string): Promise<boolean> {
    if (!this.sdkState.resolve()) {
      return false
    }
    const devices = await this.listDevices()
    return devices.some((device) => device.id === id || device.name === id)
  }

  async resolveDeviceId(deviceOrName: string): Promise<string> {
    const sdk = this.requireSdk()
    const running = await listRunningAdbDevices(this.runner, sdk)
    if (running.some((device) => device.serial === deviceOrName)) {
      return deviceOrName
    }
    const serial = await findRunningAvdSerial(this.runner, sdk, deviceOrName, running)
    if (serial) {
      return serial
    }
    throw new EmulatorError(
      'emulator_device_not_found',
      `Android device "${deviceOrName}" is not running. Boot it first.`
    )
  }

  async startSession(deviceId: string): Promise<EmulatorSessionInfo> {
    return this.streams.start(await this.ensureBooted(deviceId))
  }

  async stopHelperForDevice(
    deviceId: string,
    options: { helperPid?: number; includeOrphaned?: boolean } = {}
  ): Promise<void> {
    this.streams.stop(deviceId)
    // Reap a port-forward leaked by an unclean exit: the in-memory handle is gone
    // after a crash, so streams.stop can't remove it. Best-effort, serial-scoped,
    // and must never throw on this teardown path.
    if (options.includeOrphaned) {
      const sdk = this.sdkState.resolve()
      if (!sdk) {
        return
      }
      const serial = await this.resolveDeviceId(deviceId).catch(() => null)
      if (!serial) {
        return
      }
      // `-s <serial>` scopes --remove-all to this device's adb forwards only.
      await this.runner(sdk.adb, ['-s', serial, 'forward', '--remove-all']).catch(() => {})
    }
  }

  async shutdownDevice(deviceId: string): Promise<void> {
    const sdk = this.requireSdk()
    const serial = await this.resolveDeviceId(deviceId)
    this.screenSizes.delete(serial)
    ensureAdbOk(await this.runner(sdk.adb, emuKillArgs(serial)), 'adb emulator shutdown')
  }

  async isSessionReusable(info: EmulatorSessionInfo): Promise<boolean> {
    // Reuse a live scrcpy stream so a renderer remount reconnects to it (the
    // registry replays meta + config + GOP) instead of respawning the server.
    return scrcpyVideoRegistry.has(info.deviceUdid)
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    const serial = await this.resolveDeviceId(deviceId)
    await androidTap(this.runner, this.requireSdk(), serial, x, y, await this.getScreenSize(serial))
  }

  async gesture(
    deviceId: string,
    points: EmulatorGesturePoint[],
    _wsUrl: string | null
  ): Promise<void> {
    const serial = await this.resolveDeviceId(deviceId)
    await androidSwipe(
      this.runner,
      this.requireSdk(),
      serial,
      points,
      await this.getScreenSize(serial)
    )
  }

  async type(deviceId: string, text: string): Promise<void> {
    await androidTypeText(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId),
      text
    )
  }

  async button(deviceId: string, name: string): Promise<void> {
    await androidButton(this.runner, this.requireSdk(), await this.resolveDeviceId(deviceId), name)
  }

  async rotate(deviceId: string, orientation: string): Promise<void> {
    const serial = await this.resolveDeviceId(deviceId)
    this.screenSizes.delete(serial)
    await androidRotate(this.runner, this.requireSdk(), serial, orientation)
  }

  async exec(deviceId: string, command: string): Promise<unknown> {
    return androidExec(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId),
      command
    )
  }

  async installApp(
    deviceId: string,
    apkPath: string,
    options?: { reinstall?: boolean }
  ): Promise<void> {
    await this.withSerial(deviceId, (sdk, serial) =>
      installAndroidApk(this.runner, sdk, serial, apkPath, options)
    )
  }

  async launchApp(deviceId: string, packageName: string, activity?: string): Promise<void> {
    await this.withSerial(deviceId, (sdk, serial) =>
      launchAndroidApp(this.runner, sdk, serial, packageName, activity)
    )
  }

  async setPermission(
    deviceId: string,
    op: AndroidPermissionOp,
    packageName: string,
    permission?: string
  ): Promise<void> {
    await this.withSerial(deviceId, (sdk, serial) =>
      setAndroidPermission(this.runner, sdk, serial, op, packageName, permission)
    )
  }

  async accessibilityTree(deviceId: string): Promise<unknown> {
    return this.withSerial(deviceId, (sdk, serial) =>
      dumpAndroidAccessibilityTree(this.runner, sdk, serial)
    )
  }

  async logcat(
    deviceId: string,
    options?: { lines?: number; filters?: readonly string[] }
  ): Promise<unknown> {
    return this.withSerial(deviceId, (sdk, serial) =>
      captureAndroidLogcat(this.runner, sdk, serial, options)
    )
  }

  private async withSerial<T>(
    deviceId: string,
    run: (sdk: AndroidSdkPaths, serial: string) => Promise<T>
  ): Promise<T> {
    return run(this.requireSdk(), await this.resolveDeviceId(deviceId))
  }

  // Boots an AVD (by name) when not running and waits for boot; returns the serial.
  async ensureBooted(deviceOrName: string): Promise<string> {
    return bootAndroidDevice(this.runner, this.requireSdk(), deviceOrName, {
      bootTimeoutMs: this.bootTimeoutMs,
      pollIntervalMs: this.pollIntervalMs,
      sleep: this.sleep
    })
  }

  private async getScreenSize(serial: string): Promise<DeviceScreenSize> {
    const cached = this.screenSizes.get(serial)
    if (cached) {
      return cached
    }
    const sdk = this.requireSdk()
    const result = await this.runner(sdk.adb, wmSizeArgs(serial))
    const size = parseWmSize(result.stdout)
    if (!size) {
      throw new EmulatorError('emulator_error', `Could not read screen size for ${serial}.`)
    }
    this.screenSizes.set(serial, size)
    return size
  }

  private requireSdk(): AndroidSdkPaths {
    return this.sdkState.require()
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
