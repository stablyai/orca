import type { GlobalSettings } from '../../shared/global-settings-types'
import { createCodexAccountSettings } from './codex-account-settings-fixture'
import {
  setShellStartupEnvProbeSupportedForTest,
  testState
} from './runtime-home-service-test-harness'

// Why: the shared system-default mirror is still live wherever the shell-startup
// probe is unavailable (Windows), so drive this suite's lane coverage and
// mid-test flips through that real gate rather than a test-only override.
type TestSettingsOverrides = Partial<GlobalSettings> & {
  shellStartupEnvProbeSupported?: boolean
}

export function createSettings(overrides: TestSettingsOverrides = {}): GlobalSettings {
  // Mirror-path tests assert the shared runtime home, which production still uses
  // on Windows; opt these cases onto that lane unless a test overrides it.
  setShellStartupEnvProbeSupportedForTest(overrides.shellStartupEnvProbeSupported ?? false)
  return createCodexAccountSettings(testState.fakeHomeDir, overrides)
}
