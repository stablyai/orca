import { MacOSNativeProviderClient } from './macos-native-provider-client'
import { shouldUseMacOSNativeProvider } from './macos-native-provider-availability'
import {
  DesktopScriptProviderClient,
  shouldUseDesktopScriptProvider
} from './desktop-script-provider-client'

type ComputerProvider = MacOSNativeProviderClient | DesktopScriptProviderClient

type ComputerProviderLifecycleDeps = {
  shouldUseMacOSNativeProvider: () => boolean
  createMacOSNativeProvider: () => MacOSNativeProviderClient
  shouldUseDesktopScriptProvider: () => boolean
  createDesktopScriptProvider: () => DesktopScriptProviderClient
}

const defaultDeps: ComputerProviderLifecycleDeps = {
  shouldUseMacOSNativeProvider,
  createMacOSNativeProvider: () => new MacOSNativeProviderClient(),
  shouldUseDesktopScriptProvider,
  createDesktopScriptProvider: () => new DesktopScriptProviderClient()
}

export class ComputerProviderLifecycle {
  private nativeMacOSProvider: MacOSNativeProviderClient | null = null
  private desktopScriptProvider: DesktopScriptProviderClient | null = null

  constructor(private readonly deps: ComputerProviderLifecycleDeps = defaultDeps) {}

  current(platform: NodeJS.Platform = process.platform): ComputerProvider | null {
    if (platform === 'darwin') {
      if (this.nativeMacOSProvider) {
        return this.nativeMacOSProvider
      }
      if (this.deps.shouldUseMacOSNativeProvider()) {
        this.nativeMacOSProvider = this.deps.createMacOSNativeProvider()
        return this.nativeMacOSProvider
      }
    }

    if (this.desktopScriptProvider) {
      return this.desktopScriptProvider
    }
    if (this.deps.shouldUseDesktopScriptProvider()) {
      this.desktopScriptProvider = this.deps.createDesktopScriptProvider()
      return this.desktopScriptProvider
    }
    return null
  }

  shutdown(): void {
    this.nativeMacOSProvider?.shutdown()
    this.nativeMacOSProvider = null
    this.desktopScriptProvider?.shutdown()
    this.desktopScriptProvider = null
  }
}

const lifecycle = new ComputerProviderLifecycle()

export function currentComputerProvider(): ComputerProvider | null {
  return lifecycle.current()
}

export function shutdownComputerProviders(): void {
  lifecycle.shutdown()
}
