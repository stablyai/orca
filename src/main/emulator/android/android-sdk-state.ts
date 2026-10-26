import { discoverAndroidSdkFromHost } from './android-sdk-host-discovery'
import { EmulatorError } from '../emulator-errors'
import type { AndroidSdkPaths } from './android-sdk-discovery'

const SDK_MISSING = 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'

// Rediscover host SDKs per call so installs and settings changes work without restarting.
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
