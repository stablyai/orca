import { discoverHarmonySdkFromHost } from './harmony-sdk-host-discovery'
import { EmulatorError } from '../emulator-errors'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

const SDK_MISSING =
  'HarmonyOS toolchain not found. Install DevEco Studio (with the HarmonyOS SDK and Emulator).'

// An injected toolchain (tests, or an explicit null) is fixed; for the real
// host discovery re-runs on every call so a newly-installed toolchain or a
// changed configured path takes effect without a restart.
export class HarmonySdkState {
  constructor(
    private readonly injected: boolean,
    private readonly injectedSdk: HarmonySdkPaths | null
  ) {}

  resolve(): HarmonySdkPaths | null {
    return this.injected ? this.injectedSdk : discoverHarmonySdkFromHost()
  }

  require(): HarmonySdkPaths {
    const sdk = this.resolve()
    if (!sdk) {
      throw new EmulatorError('emulator_error', SDK_MISSING)
    }
    return sdk
  }
}
