import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import {
  NEW_TAB_MENU_LAYOUT_SETTING,
  normalizeNewTabMenuLayout
} from '../../../shared/new-tab-menu/new-tab-menu-layout'

// Plugin consent and enablement require main's reviewed-fingerprint handlers.
// Account configuration must stop old writers and commit through the host account operation.
// The settings file sync alone owns its removal-tracking key list.
// The server preference is owned by Advanced controls; only the main-process directory picker may grant trusted floating-workspace paths.
export const RENDERER_DENIED_SETTINGS_KEYS = [
  'antigravityChatAuth',
  'pluginConsents',
  'disabledPlugins',
  'pluginExternalHostGrants',
  'activeRuntimeEnvironmentId',
  'floatingTerminalTrustedCwds',
  'settingsFileLastSeenKeys'
] as const satisfies readonly (keyof GlobalSettings)[]

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

export function sanitizeRendererSettingsUpdate(
  args: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This legacy field is removed before the typed update is returned.
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedArgs } =
    args as LegacyTerminalScrollbackSettingsUpdate
  void _legacyScrollbackBytes
  for (const key of RENDERER_DENIED_SETTINGS_KEYS) {
    delete sanitizedArgs[key]
  }
  // Only main's assignment writes this; other telemetry fields keep their existing handling.
  if (sanitizedArgs.telemetry && 'browserExtensionsBanner' in sanitizedArgs.telemetry) {
    const { browserExtensionsBanner: _mainOwned, ...telemetry } = sanitizedArgs.telemetry
    void _mainOwned
    sanitizedArgs.telemetry = telemetry
  }
  if (
    'browserPasswordsFillRequiresReauth' in sanitizedArgs &&
    typeof sanitizedArgs.browserPasswordsFillRequiresReauth !== 'boolean'
  ) {
    delete sanitizedArgs.browserPasswordsFillRequiresReauth
  }
  for (const key of Object.values(NEW_TAB_MENU_LAYOUT_SETTING)) {
    if (key in sanitizedArgs) {
      sanitizedArgs[key] = normalizeNewTabMenuLayout(sanitizedArgs[key])
    }
  }
  return sanitizedArgs
}
