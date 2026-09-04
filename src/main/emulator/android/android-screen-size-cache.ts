import { EmulatorError } from '../emulator-errors'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import type { DeviceScreenSize } from './android-input-mapping'
import { parseWmSize, wmSizeArgs } from './adb-devices'

export type AndroidScreenSizeCacheDeps = {
  runner: AndroidCommandRunner
  sdk: () => AndroidSdkPaths
}

// Caches the `wm size` read per serial: every tap/swipe needs it, but a
// device's resolution only changes on rotation (which clears its entry).
export class AndroidScreenSizeCache {
  private readonly sizes = new Map<string, DeviceScreenSize>()

  constructor(private readonly deps: AndroidScreenSizeCacheDeps) {}

  async get(serial: string): Promise<DeviceScreenSize> {
    const cached = this.sizes.get(serial)
    if (cached) {
      return cached
    }
    const result = await this.deps.runner(this.deps.sdk().adb, wmSizeArgs(serial))
    const size = parseWmSize(result.stdout)
    if (!size) {
      throw new EmulatorError('emulator_error', `Could not read screen size for ${serial}.`)
    }
    this.sizes.set(serial, size)
    return size
  }

  clear(serial: string): void {
    this.sizes.delete(serial)
  }
}
