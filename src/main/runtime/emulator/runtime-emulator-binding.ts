import type { EmulatorBridge } from '../../emulator/emulator-bridge'
import { RuntimeBrowserHostBindings } from '../browser/installation/runtime-browser-host-bindings'

export abstract class RuntimeEmulatorBinding extends RuntimeBrowserHostBindings {
  private emulatorBridgeLoader: (() => Promise<EmulatorBridge>) | null = null
  private emulatorBridgePromise: Promise<EmulatorBridge> | null = null

  setEmulatorBridge(bridge: EmulatorBridge | null): void {
    this.emulatorBridge = bridge
    this.emulatorBridgeLoader = null
    this.emulatorBridgePromise = null
  }

  setEmulatorBridgeLoader(loader: () => Promise<EmulatorBridge>): void {
    this.emulatorBridgeLoader = loader
    this.emulatorBridgePromise = null
  }

  getEmulatorBridge(): EmulatorBridge | null {
    return this.emulatorBridge
  }

  ensureEmulatorBridge(): Promise<EmulatorBridge | null> {
    if (this.emulatorBridge) {
      return Promise.resolve(this.emulatorBridge)
    }
    const loader = this.emulatorBridgeLoader
    if (!loader) {
      return Promise.resolve(null)
    }
    if (!this.emulatorBridgePromise) {
      this.emulatorBridgePromise = loader()
        .then((bridge) => {
          this.emulatorBridge = bridge
          return bridge
        })
        .catch((error: unknown) => {
          this.emulatorBridgePromise = null
          throw error
        })
    }
    return this.emulatorBridgePromise
  }
}
