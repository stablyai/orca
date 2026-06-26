import { homedir, platform } from 'node:os'
import { existsSync } from 'node:fs'
import { EmulatorError } from '../emulator-errors'
import type { EmulatorSessionInfo } from '../emulator-types'
import type {
  BackendAvailability,
  EmulatorBackend,
  EmulatorBackendCapabilities,
  EmulatorDevice
} from './emulator-backend'
import { discoverAndroidSdk, type AndroidSdkPaths } from '../android/android-sdk-discovery'
import { bootCompletedArgs, isBootCompleted, parseWmSize, wmSizeArgs } from '../android/adb-devices'
import { bootAvdArgs, emuKillArgs } from '../android/avd-manager'
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
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

export type AndroidEmulatorBackendOptions = {
  runner?: AndroidCommandRunner
  // Inject discovered SDK paths (tests); undefined means auto-discover, null means "no SDK".
  sdk?: AndroidSdkPaths | null
  bootTimeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_BOOT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

// The Android backend. Device discovery + lifecycle + input run through `adb`
// and the `emulator` binary; the live H.264 pane (scrcpy) is wired in a later
// phase. Input uses `adb shell input` so it works without the scrcpy server.
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
  private readonly sdk: AndroidSdkPaths | null
  private readonly bootTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly screenSizes = new Map<string, DeviceScreenSize>()

  constructor(options: AndroidEmulatorBackendOptions = {}) {
    this.runner = options.runner ?? execFileAndroidCommandRunner
    this.sdk = options.sdk !== undefined ? options.sdk : safeDiscoverSdk()
    this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.sleep = options.sleep ?? defaultSleep
  }

  isSupportedOnHost(): boolean {
    return this.sdk !== null
  }

  async checkAvailability(): Promise<BackendAvailability> {
    if (!this.sdk) {
      return {
        available: false,
        devices: [],
        message: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'
      }
    }
    let devices: EmulatorDevice[] = []
    try {
      devices = await this.listDevices()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'adb is unavailable.'
      return { available: false, devices: [], message }
    }
    if (devices.length === 0) {
      return {
        available: false,
        devices,
        message: 'No Android devices or AVDs found. Create one in Android Studio.'
      }
    }
    return { available: true, devices, message: 'Ready' }
  }

  async listDevices(): Promise<EmulatorDevice[]> {
    return this.sdk ? listAndroidDevices(this.runner, this.sdk) : []
  }

  async ownsDevice(id: string): Promise<boolean> {
    if (!this.sdk) {
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
    // Boot if needed so the device is ready for the (later) scrcpy stream.
    await this.ensureBooted(deviceId)
    throw new EmulatorError(
      'emulator_helper_failed',
      'Android live streaming (scrcpy) is added in the streaming phase; device control works via the CLI.'
    )
  }

  async stopHelperForDevice(): Promise<void> {
    // No scrcpy helper exists yet; nothing to stop until the streaming phase.
  }

  async shutdownDevice(deviceId: string): Promise<void> {
    const sdk = this.requireSdk()
    const serial = await this.resolveDeviceId(deviceId)
    this.screenSizes.delete(serial)
    await this.runner(sdk.adb, emuKillArgs(serial))
  }

  async isSessionReusable(): Promise<boolean> {
    // No persistent stream session yet (added with scrcpy).
    return false
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
    const sdk = this.requireSdk()
    await installAndroidApk(
      this.runner,
      sdk,
      await this.resolveDeviceId(deviceId),
      apkPath,
      options
    )
  }

  async launchApp(deviceId: string, packageName: string, activity?: string): Promise<void> {
    const sdk = this.requireSdk()
    await launchAndroidApp(
      this.runner,
      sdk,
      await this.resolveDeviceId(deviceId),
      packageName,
      activity
    )
  }

  async setPermission(
    deviceId: string,
    op: AndroidPermissionOp,
    packageName: string,
    permission?: string
  ): Promise<void> {
    const sdk = this.requireSdk()
    await setAndroidPermission(
      this.runner,
      sdk,
      await this.resolveDeviceId(deviceId),
      op,
      packageName,
      permission
    )
  }

  async accessibilityTree(deviceId: string): Promise<unknown> {
    const sdk = this.requireSdk()
    return dumpAndroidAccessibilityTree(this.runner, sdk, await this.resolveDeviceId(deviceId))
  }

  async logcat(
    deviceId: string,
    options?: { lines?: number; filters?: readonly string[] }
  ): Promise<unknown> {
    const sdk = this.requireSdk()
    return captureAndroidLogcat(this.runner, sdk, await this.resolveDeviceId(deviceId), options)
  }

  // Boots an AVD (by name) when not already running and waits for the framework
  // to come up; returns the running adb serial.
  async ensureBooted(deviceOrName: string): Promise<string> {
    const sdk = this.requireSdk()
    const running = await listRunningAdbDevices(this.runner, sdk)
    if (running.some((device) => device.serial === deviceOrName)) {
      return deviceOrName
    }
    const existingSerial = await findRunningAvdSerial(this.runner, sdk, deviceOrName, running)
    if (existingSerial) {
      return existingSerial
    }
    const knownSerials = new Set(running.map((device) => device.serial))
    // Detached: the emulator process must outlive this call.
    void this.runner(sdk.emulator, bootAvdArgs(deviceOrName), { timeoutMs: this.bootTimeoutMs })
    return this.waitForNewBootedSerial(deviceOrName, knownSerials)
  }

  private async waitForNewBootedSerial(avdName: string, known: Set<string>): Promise<string> {
    const sdk = this.requireSdk()
    let waited = 0
    while (waited < this.bootTimeoutMs) {
      const fresh = (await listRunningAdbDevices(this.runner, sdk)).filter(
        (device) => device.isEmulator && !known.has(device.serial)
      )
      for (const device of fresh) {
        const booted = await this.runner(sdk.adb, bootCompletedArgs(device.serial))
        if (isBootCompleted(booted.stdout)) {
          return device.serial
        }
      }
      await this.sleep(this.pollIntervalMs)
      waited += this.pollIntervalMs
    }
    throw new EmulatorError(
      'emulator_helper_failed',
      `AVD "${avdName}" did not finish booting in time.`
    )
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
    if (!this.sdk) {
      throw new EmulatorError(
        'emulator_error',
        'Android SDK not found. Install Android Studio and set ANDROID_HOME.'
      )
    }
    return this.sdk
  }
}

function safeDiscoverSdk(): AndroidSdkPaths | null {
  try {
    return discoverAndroidSdk({
      env: process.env,
      platform: platform(),
      homedir: homedir(),
      exists: existsSync
    })
  } catch {
    return null
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
