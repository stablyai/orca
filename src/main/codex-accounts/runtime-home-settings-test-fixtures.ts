import type { GlobalSettings } from '../../shared/global-settings-types'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
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
  const appFontFamily = overrides.appFontFamily ?? 'Geist'
  const agentStatusHooksEnabled = overrides.agentStatusHooksEnabled ?? true
  const tabAutoGenerateTitle = overrides.tabAutoGenerateTitle ?? false
  // Mirror-path tests assert the shared runtime home, which production still uses
  // on Windows; opt these cases onto that lane unless a test overrides it.
  setShellStartupEnvProbeSupportedForTest(overrides.shellStartupEnvProbeSupported ?? false)
  return createGlobalSettingsFixture({
    workspaceDir: testState.fakeHomeDir,
    // Why: these deviate from buildDefaultSettings; kept so existing assertions hold.
    nestWorkspaces: false,
    autoRenameBranchFromWork: false,
    terminalCursorBlink: false,
    terminalThemeDark: 'orca-dark',
    terminalDividerColorDark: '#000000',
    terminalUseSeparateLightTheme: false,
    terminalThemeLight: 'orca-light',
    terminalDividerColorLight: '#ffffff',
    terminalPaneOpacityTransitionMs: 150,
    terminalDividerThicknessPx: 1,
    setupScriptLaunchMode: 'split-vertical',
    localAccountRuntime: 'host',
    floatingTerminalEnabled: false,
    terminalMacOptionAsAlt: 'false',
    terminalMacOptionAsAltMigrated: true,
    experimentalActivity: true,
    terminalWindowsPowerShellImplementation: 'powershell.exe',
    ...overrides,
    diffWordWrap: overrides.diffWordWrap ?? false,
    diffShowWhitespace: overrides.diffShowWhitespace ?? false,
    localWindowsRuntimeDefault: overrides.localWindowsRuntimeDefault ?? {
      kind: 'windows-host'
    },
    leftSidebarAppearanceMode: overrides.leftSidebarAppearanceMode ?? 'default',
    appFontFamily,
    agentStatusHooksEnabled,
    tabAutoGenerateTitle
  })
}
