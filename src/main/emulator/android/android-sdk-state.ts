import { discoverAndroidSdkFromHost } from './android-sdk-host-discovery'
import { EmulatorError } from '../emulator-errors'
import { emulatorFailureText } from '../../../shared/emulator-failure-copy'
import type { AndroidSdkPaths } from './android-sdk-discovery'

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
      throw new EmulatorError('emulator_error', emulatorFailureText('androidSdkMissing'))
    }
    return sdk
  }
}
