import type { GlobalSettings } from '../../shared/global-settings-types'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'

// Why: these values predate buildDefaultSettings' current defaults; codex-account suites assert against them.
export function createCodexAccountSettings(
  workspaceDir: string,
  overrides: Partial<GlobalSettings> = {}
): GlobalSettings {
  return createGlobalSettingsFixture({
    workspaceDir,
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
    localWindowsRuntimeDefault: overrides.localWindowsRuntimeDefault ?? { kind: 'windows-host' },
    leftSidebarAppearanceMode: overrides.leftSidebarAppearanceMode ?? 'default',
    appFontFamily: overrides.appFontFamily ?? 'Geist',
    agentStatusHooksEnabled: overrides.agentStatusHooksEnabled ?? true,
    tabAutoGenerateTitle: overrides.tabAutoGenerateTitle ?? false
  })
}
