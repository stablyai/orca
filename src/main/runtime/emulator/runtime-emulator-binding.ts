import type { EmulatorBridge } from '../../emulator/emulator-bridge'
import { RuntimeBrowserHostBindings } from '../browser/installation/runtime-browser-host-bindings'

export abstract class RuntimeEmulatorBinding extends RuntimeBrowserHostBindings {
  setEmulatorBridge(bridge: EmulatorBridge | null): void {
    this.emulatorBridge = bridge
  }

  getEmulatorBridge(): EmulatorBridge | null {
    return this.emulatorBridge
  }
}
