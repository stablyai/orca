import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'

import { HERMES_CLIENT_ENV_PASSTHROUGH, HERMES_PLUGIN_NAME } from './hermes-managed-plugin-source'
import { updateHermesPluginDocument } from './hermes-config-document'

export type HermesConfig = Record<string, unknown>

export type ConfigParseResult = { ok: true; config: HermesConfig } | { ok: false; detail: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] | null {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return null
  }
  return value
}

export function parseHermesConfig(content: string | null): ConfigParseResult {
  if (!content || content.trim().length === 0) {
    return { ok: true, config: {} }
  }
  try {
    const parsed = parse(content) as unknown
    if (parsed === null || parsed === undefined) {
      return { ok: true, config: {} }
    }
    if (!isRecord(parsed)) {
      return { ok: false, detail: 'Hermes config.yaml root must be a mapping' }
    }
    return { ok: true, config: { ...parsed } }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export function enablePlugin(config: HermesConfig): HermesConfig {
  const next: HermesConfig = { ...config }
  const plugins = isRecord(next.plugins) ? { ...next.plugins } : {}
  const enabled = asStringArray(plugins.enabled) ?? []
  const disabled = asStringArray(plugins.disabled)
  plugins.enabled = enabled.includes(HERMES_PLUGIN_NAME)
    ? enabled
    : [...enabled, HERMES_PLUGIN_NAME]
  if (disabled === null) {
    // Match Hermes' loader: malformed disabled lists behave as empty.
    plugins.disabled = []
  } else if (disabled.includes(HERMES_PLUGIN_NAME)) {
    const filtered = disabled.filter((name) => name !== HERMES_PLUGIN_NAME)
    plugins.disabled = filtered
  }
  next.plugins = plugins
  return next
}

export function disablePlugin(config: HermesConfig): HermesConfig {
  const next: HermesConfig = { ...config }
  if (!isRecord(next.plugins)) {
    return next
  }
  const plugins = { ...next.plugins }
  const enabled = asStringArray(plugins.enabled)
  if (enabled !== null && plugins.enabled !== undefined) {
    plugins.enabled = enabled.filter((name) => name !== HERMES_PLUGIN_NAME)
  }
  next.plugins = plugins
  return next
}

function updatePassthrough(
  config: HermesConfig,
  update: (names: string[]) => string[]
): HermesConfig {
  const terminal = config.terminal === undefined ? {} : config.terminal
  // Hermes ignores a malformed section; leave it for the user rather than fail the plugin install.
  const names = isRecord(terminal) ? asStringArray(terminal.client_env_passthrough) : null
  if (names === null) {
    return config
  }
  const next = update(names)
  return isDeepStrictEqual(names, next)
    ? config
    : { ...config, terminal: { ...terminal, client_env_passthrough: next } }
}

function addOrcaPassthrough(config: HermesConfig): HermesConfig {
  return updatePassthrough(config, (names) => [
    ...names,
    ...HERMES_CLIENT_ENV_PASSTHROUGH.filter((name) => !names.includes(name))
  ])
}

export function installOrcaStatusConfig(config: HermesConfig): HermesConfig {
  return addOrcaPassthrough(enablePlugin(config))
}

export function removeOrcaStatusConfig(config: HermesConfig): HermesConfig {
  return updatePassthrough(disablePlugin(config), (names) =>
    names.filter((name) => !HERMES_CLIENT_ENV_PASSTHROUGH.includes(name))
  )
}

export function updateConfigContent(
  content: string | null,
  updater: (config: HermesConfig) => HermesConfig
): { content: string | null; detail?: string } {
  const parsed = parseHermesConfig(content)
  if (!parsed.ok) {
    return { content: null, detail: parsed.detail }
  }
  const next = updater(parsed.config)
  if (isDeepStrictEqual(parsed.config, next)) {
    return { content: content ?? '' }
  }
  return updateHermesPluginDocument(content ?? '', parsed.config, next)
}

// Why: the passthrough is best-effort; a terminal section we can't safely edit must not block the plugin.
function updateWithPluginFallback(
  content: string | null,
  updater: (config: HermesConfig) => HermesConfig,
  pluginOnly: (config: HermesConfig) => HermesConfig
): { content: string | null; detail?: string } {
  const next = updateConfigContent(content, updater)
  return next.content === null ? updateConfigContent(content, pluginOnly) : next
}

export function installOrcaStatusContent(content: string | null) {
  return updateWithPluginFallback(content, installOrcaStatusConfig, enablePlugin)
}

export function removeOrcaStatusContent(content: string | null) {
  return updateWithPluginFallback(content, removeOrcaStatusConfig, disablePlugin)
}

export function getConfigEnablement(config: HermesConfig): {
  enabled: boolean
  disabled: boolean
  detail: string | null
} {
  if (!isRecord(config.plugins)) {
    return { enabled: false, disabled: false, detail: 'plugins.enabled is missing' }
  }
  const enabled = asStringArray(config.plugins.enabled)
  const disabled = asStringArray(config.plugins.disabled)
  if (enabled === null) {
    return { enabled: false, disabled: false, detail: 'plugins.enabled is not a string list' }
  }
  if (disabled === null) {
    return { enabled: false, disabled: false, detail: 'plugins.disabled is not a string list' }
  }
  return {
    enabled: enabled.includes(HERMES_PLUGIN_NAME),
    disabled: disabled.includes(HERMES_PLUGIN_NAME),
    detail: null
  }
}

/** A named profile's passthrough, refreshed only while the user keeps orca-status enabled there; null skips the profile. */
export function refreshProfileOrcaStatusContent(content: string | null): {
  content: string | null
} {
  const parsed = parseHermesConfig(content)
  if (!parsed.ok) {
    return { content: null }
  }
  const { enabled, disabled } = getConfigEnablement(parsed.config)
  return enabled && !disabled ? updateConfigContent(content, addOrcaPassthrough) : { content: null }
}
