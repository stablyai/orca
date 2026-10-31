import type { GlobalSettings } from '../../shared/global-settings-types'
import { createCodexAccountSettings } from './codex-account-settings-fixture'
import { setRealHomeRoutableForTest, testState } from './runtime-home-service-test-harness'

type TestSettingsOverrides = Partial<GlobalSettings> & {
  realHomeRoutable?: boolean
}

export function createSettings(overrides: TestSettingsOverrides = {}): GlobalSettings {
  // Default to the production custom-CODEX_HOME route for mirror-path assertions.
  setRealHomeRoutableForTest(overrides.realHomeRoutable ?? false)
  return createCodexAccountSettings(testState.fakeHomeDir, overrides)
}
