import { EmulatorError } from '../emulator-errors'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'
import type {
  EmulatorButtonOptions,
  EmulatorPosture
} from '../../../shared/emulator-device-controls'
import type { AndroidCommandRunner } from './android-command-runner'
import {
  androidButton,
  androidExec,
  androidRotate,
  androidSetPosture,
  androidSwipe,
  androidTap,
  androidTypeText
} from './android-input-commands'
import { parseWmSize, wmSizeArgs } from './adb-devices'
import type { DeviceScreenSize } from './android-input-mapping'
import type { AndroidSdkPaths } from './android-sdk-discovery'

type AndroidEmulatorInputControllerOptions = {
  runner: AndroidCommandRunner
  sdk: () => AndroidSdkPaths
  resolveDeviceId: (deviceId: string) => Promise<string>
}

export class AndroidEmulatorInputController {
  private readonly runner: AndroidCommandRunner
  private readonly sdk: () => AndroidSdkPaths
  private readonly resolveDeviceId: (deviceId: string) => Promise<string>
  private readonly screenSizes = new Map<string, DeviceScreenSize>()

  constructor(options: AndroidEmulatorInputControllerOptions) {
    this.runner = options.runner
    this.sdk = options.sdk
    this.resolveDeviceId = options.resolveDeviceId
  }

  invalidateScreenSize(serial: string): void {
    this.screenSizes.delete(serial)
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    const serial = await this.resolveDeviceId(deviceId)
    await androidTap(this.runner, this.sdk(), serial, x, y, await this.getScreenSize(serial))
  }

  async gesture(deviceId: string, points: EmulatorGesturePoint[]): Promise<void> {
    const serial = await this.resolveDeviceId(deviceId)
    await androidSwipe(this.runner, this.sdk(), serial, points, await this.getScreenSize(serial))
  }

  async type(deviceId: string, text: string): Promise<void> {
    await androidTypeText(this.runner, this.sdk(), await this.resolveDeviceId(deviceId), text)
  }

  async button(deviceId: string, name: string, options?: EmulatorButtonOptions): Promise<void> {
    await androidButton(
      this.runner,
      this.sdk(),
      await this.resolveDeviceId(deviceId),
      name,
      options
    )
  }

  async setPosture(deviceId: string, posture: EmulatorPosture): Promise<void> {
    await androidSetPosture(this.runner, this.sdk(), await this.resolveDeviceId(deviceId), posture)
  }

  async rotate(deviceId: string, orientation: string): Promise<void> {
    const serial = await this.resolveDeviceId(deviceId)
    this.invalidateScreenSize(serial)
    await androidRotate(this.runner, this.sdk(), serial, orientation)
  }

  async exec(deviceId: string, command: string): Promise<string> {
    return androidExec(this.runner, this.sdk(), await this.resolveDeviceId(deviceId), command)
  }

  private async getScreenSize(serial: string): Promise<DeviceScreenSize> {
    const cached = this.screenSizes.get(serial)
    if (cached) {
      return cached
    }
    const result = await this.runner(this.sdk().adb, wmSizeArgs(serial))
    const size = parseWmSize(result.stdout)
    if (!size) {
      throw new EmulatorError('emulator_error', `Could not read screen size for ${serial}.`)
    }
    this.screenSizes.set(serial, size)
    return size
  }
}
