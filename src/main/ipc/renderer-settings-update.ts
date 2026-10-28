import type { GlobalSettings } from '../../shared/global-settings-types'

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
  // Plugin consent and enablement require main's reviewed-fingerprint handlers.
  delete sanitizedArgs.pluginConsents
  delete sanitizedArgs.disabledPlugins
  if (
    'browserPasswordsFillRequiresReauth' in sanitizedArgs &&
    typeof sanitizedArgs.browserPasswordsFillRequiresReauth !== 'boolean'
  ) {
    delete sanitizedArgs.browserPasswordsFillRequiresReauth
  }
  return sanitizedArgs
}
