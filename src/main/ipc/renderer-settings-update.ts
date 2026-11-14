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
  // Account configuration must stop old writers and commit through the host account operation.
  delete sanitizedArgs.antigravityChatAuth
  delete sanitizedArgs.pluginConsents
  delete sanitizedArgs.disabledPlugins
  delete sanitizedArgs.pluginExternalHostGrants
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
  return sanitizedArgs
}
