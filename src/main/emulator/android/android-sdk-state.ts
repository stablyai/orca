import { discoverAndroidSdkFromHost } from './android-sdk-host-discovery'
import { EmulatorError } from '../emulator-errors'
import type { AndroidSdkPaths } from './android-sdk-discovery'

const SDK_MISSING = 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'

// Holds the backend's resolved Android SDK and re-resolves it for the host case
// so a newly-installed or newly-configured SDK is picked up without a restart.
// An injected SDK (tests, or an explicit null) is fixed and never re-resolved.
export class AndroidSdkState {
  private sdk: AndroidSdkPaths | null

  constructor(
    private readonly injected: boolean,
    initial: AndroidSdkPaths | null
  ) {
    this.sdk = initial
  }

  // force re-runs host discovery even when an SDK was already found, so a changed
  // configured path takes effect; otherwise discovery only runs while unresolved.
  resolve(force = false): AndroidSdkPaths | null {
    if (!this.injected && (force || !this.sdk)) {
      this.sdk = discoverAndroidSdkFromHost()
    }
    return this.sdk
  }

  require(): AndroidSdkPaths {
    const sdk = this.resolve()
    if (!sdk) {
      throw new EmulatorError('emulator_error', SDK_MISSING)
    }
    return sdk
  }
}
