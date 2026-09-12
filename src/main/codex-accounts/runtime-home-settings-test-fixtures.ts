import type { GlobalSettings } from '../../shared/global-settings-types'
import { createCodexAccountSettings } from './codex-account-settings-fixture'
import {
  setShellStartupEnvProbeSupportedForTest,
  testState
} from './runtime-home-service-test-harness'

// Why: this suite's cases assert the shared system-default mirror. Production
// no longer reaches that lane by platform -- it is reached by a host account
// selection, a custom CODEX_HOME, or an incapable trust-grant host -- so the
// knob below is a test-only lane lever, not a mirror of a platform gate.
type TestSettingsOverrides = Partial<GlobalSettings> & {
  shellStartupEnvProbeSupported?: boolean
}

export function createSettings(overrides: TestSettingsOverrides = {}): GlobalSettings {
  // Default these cases onto the mirror lane. NOT a platform statement: since
  // the win32 lane block was removed, production reaches the mirror only via
  // selection, a custom CODEX_HOME, or an incapable trust-grant host.
  setShellStartupEnvProbeSupportedForTest(overrides.shellStartupEnvProbeSupported ?? false)
  return createCodexAccountSettings(testState.fakeHomeDir, overrides)
}
