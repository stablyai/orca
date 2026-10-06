import type { GlobalSettings } from '../../shared/global-settings-types'
import { createCodexAccountSettings } from './codex-account-settings-fixture'
import { setRealHomeRoutableForTest, testState } from './runtime-home-service-test-harness'

// Why: the shared system-default mirror is still live for a custom CODEX_HOME,
// so drive this suite's lane coverage and mid-test flips through that real gate
// rather than a test-only override.
type TestSettingsOverrides = Partial<GlobalSettings> & {
  realHomeRoutable?: boolean
}

export function createSettings(overrides: TestSettingsOverrides = {}): GlobalSettings {
  // Mirror-path tests assert the shared runtime home, which production still uses
  // for a custom CODEX_HOME; opt these cases onto that lane unless a test overrides it.
  setRealHomeRoutableForTest(overrides.realHomeRoutable ?? false)
  return createCodexAccountSettings(testState.fakeHomeDir, overrides)
}
