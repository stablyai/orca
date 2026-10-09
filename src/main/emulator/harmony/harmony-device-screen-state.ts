import { EmulatorError } from '../emulator-errors'
import type { DeviceScreenSize } from './harmony-input-mapping'

export type HarmonyDeviceScreenStateDeps = {
  // Captures the screen's current dimensions (snapshot_display stdout only).
  probeSize: (connectKey: string) => Promise<DeviceScreenSize>
  // Configured portrait panel dimensions for an instance, null when unknown.
  findLcdDimensions: (instanceName: string) => Promise<DeviceScreenSize | null>
}

// Tracks per-target screen dimensions and per-instance orientation. Snapshot
// dims cannot distinguish landscape left/right (index 1 vs 3), but coordinate
// mapping and rotation step math only need portrait/landscape parity.
export class HarmonyDeviceScreenState {
  private readonly sizes = new Map<string, DeviceScreenSize>()
  private readonly orientationByInstance = new Map<string, number>()

  constructor(private readonly deps: HarmonyDeviceScreenStateDeps) {}

  async getScreenSize(connectKey: string, instanceName: string | null): Promise<DeviceScreenSize> {
    const cached = this.sizes.get(connectKey)
    if (cached) {
      return cached
    }
    let size: DeviceScreenSize | null = null
    if (instanceName) {
      const lcd = await this.deps.findLcdDimensions(instanceName)
      if (lcd) {
        size = this.isLandscape(this.orientationByInstance.get(instanceName))
          ? { width: lcd.height, height: lcd.width }
          : lcd
      }
    }
    if (!size) {
      size = await this.deps.probeSize(connectKey)
    }
    this.sizes.set(connectKey, size)
    return size
  }

  // One snapshot at attach reconciles true dimensions/orientation with a device
  // booted outside Orca (the in-memory state did not exist).
  async prime(connectKey: string, instanceName: string | null): Promise<void> {
    const size = await this.deps.probeSize(connectKey)
    this.sizes.set(connectKey, size)
    if (instanceName) {
      this.orientationByInstance.set(instanceName, size.width > size.height ? 1 : 0)
    }
  }

  // Verifies the rotation took effect: phone images return success from
  // -rotation but frames never change. State is updated on success only.
  async verifyRotation(
    connectKey: string,
    instanceName: string,
    targetIndex: number
  ): Promise<DeviceScreenSize> {
    const size = await this.deps.probeSize(connectKey)
    const landscape = size.width > size.height
    if (landscape !== this.isLandscape(targetIndex)) {
      this.orientationByInstance.set(instanceName, landscape ? 1 : 0)
      throw new EmulatorError('emulator_error', 'Rotation did not take effect on the device.')
    }
    this.orientationByInstance.set(instanceName, targetIndex)
    this.sizes.set(connectKey, size)
    return size
  }

  orientation(instanceName: string): number {
    return this.orientationByInstance.get(instanceName) ?? 0
  }

  clear(connectKey: string, instanceName: string): void {
    this.sizes.delete(connectKey)
    this.orientationByInstance.delete(instanceName)
  }

  private isLandscape(index: number | undefined): boolean {
    return index === 1 || index === 3
  }
}
