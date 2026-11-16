import { EmulatorError } from '../emulator-errors'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'
import { parseWmSize, wmSizeArgs } from './adb-devices'
import type { AndroidCommandRunner } from './android-command-runner'
import { androidButton, androidSwipe, androidTap, androidTypeText } from './android-input-commands'
import type { DeviceScreenSize } from './android-input-mapping'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import {
  sendScrcpyButton,
  sendScrcpyGesture,
  sendScrcpyTap,
  sendScrcpyText
} from './scrcpy-control-input'
import type { ScrcpyControlTarget } from './scrcpy-stream-session'

export type AndroidDeviceInputDeps = {
  runner: AndroidCommandRunner
  sdk: () => AndroidSdkPaths
  resolveSerial: (deviceId: string) => Promise<string>
  sleep: (ms: number) => Promise<void>
}

type ControlSender = (control: ScrcpyControlTarget) => boolean | Promise<boolean>
type AdbSender = (sdk: AndroidSdkPaths, serial: string) => Promise<void>

// Input prefers the live scrcpy control socket; adb shell input stays the fallback when no
// stream is open (CLI-only use) or its socket is gone.
export class AndroidDeviceInput {
  private readonly screenSizes = new Map<string, DeviceScreenSize>()

  constructor(private readonly deps: AndroidDeviceInputDeps) {}

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    await this.route(
      deviceId,
      (control) => sendScrcpyTap(control, x, y),
      async (sdk, serial) =>
        androidTap(this.deps.runner, sdk, serial, x, y, await this.screenSize(sdk, serial))
    )
  }

  async gesture(deviceId: string, points: EmulatorGesturePoint[]): Promise<void> {
    await this.route(
      deviceId,
      (control) => sendScrcpyGesture(control, points, this.deps.sleep),
      async (sdk, serial) =>
        androidSwipe(this.deps.runner, sdk, serial, points, await this.screenSize(sdk, serial))
    )
  }

  async type(deviceId: string, text: string): Promise<void> {
    await this.route(
      deviceId,
      (control) => sendScrcpyText(control, text),
      (sdk, serial) => androidTypeText(this.deps.runner, sdk, serial, text)
    )
  }

  async button(deviceId: string, name: string): Promise<void> {
    await this.route(
      deviceId,
      (control) => sendScrcpyButton(control, name),
      (sdk, serial) => androidButton(this.deps.runner, sdk, serial, name)
    )
  }

  forgetScreenSize(serial: string): void {
    this.screenSizes.delete(serial)
  }

  // Panel input already names the streaming serial, so a live session skips the adb lookup
  // that resolves AVD names.
  private async route(deviceId: string, viaControl: ControlSender, viaAdb: AdbSender) {
    let serial = deviceId
    let control = scrcpyVideoRegistry.control(deviceId)
    if (!control) {
      serial = await this.deps.resolveSerial(deviceId)
      control = scrcpyVideoRegistry.control(serial)
    }
    if (control && (await viaControl(control))) {
      return
    }
    await viaAdb(this.deps.sdk(), serial)
  }

  private async screenSize(sdk: AndroidSdkPaths, serial: string): Promise<DeviceScreenSize> {
    const cached = this.screenSizes.get(serial)
    if (cached) {
      return cached
    }
    const result = await this.deps.runner(sdk.adb, wmSizeArgs(serial))
    const size = parseWmSize(result.stdout)
    if (!size) {
      throw new EmulatorError('emulator_error', `Could not read screen size for ${serial}.`)
    }
    this.screenSizes.set(serial, size)
    return size
  }
}
