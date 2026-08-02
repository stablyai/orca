import { discoverAndroidSdkFromHost } from './android-sdk-host-discovery'
import { EmulatorError } from '../emulator-errors'
import type { AndroidSdkPaths } from './android-sdk-discovery'

const SDK_MISSING = 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'

// Resolves the backend's Android SDK. An injected SDK (tests, or an explicit
// null) is fixed; for the real host it re-runs discovery on every call so a
// newly-installed SDK or a changed configured path takes effect without a
// restart. Host discovery is only a few existsSync probes, so this is cheap.
export class AndroidSdkState {
  constructor(
    private readonly injected: boolean,
    private readonly injectedSdk: AndroidSdkPaths | null
  ) {}

  resolve(): AndroidSdkPaths | null {
    return this.injected ? this.injectedSdk : discoverAndroidSdkFromHost()
  }

  require(): AndroidSdkPaths {
    const sdk = this.resolve()
    if (!sdk) {
      throw new EmulatorError('emulator_error', SDK_MISSING)
    }
    return sdk
  }
}
