import { parse, stringify } from 'yaml'

import { HERMES_PLUGIN_NAME } from './hermes-managed-plugin-source'

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

export function serializeHermesConfig(config: HermesConfig): string {
  return `${stringify(config, { lineWidth: 0 }).trimEnd()}\n`
}

export function enablePlugin(config: HermesConfig): HermesConfig {
  const next: HermesConfig = { ...config }
  const plugins = isRecord(next.plugins) ? { ...next.plugins } : {}
  const enabled = asStringArray(plugins.enabled) ?? []
  const disabled = asStringArray(plugins.disabled)
  plugins.enabled = Array.from(new Set([...enabled, HERMES_PLUGIN_NAME])).sort()
  if (disabled === null) {
    // Why: Hermes treats a malformed disabled list as empty. Normalize it here
    // so Orca's install status matches what the real Hermes loader will do.
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
  if (enabled !== null) {
    plugins.enabled = enabled.filter((name) => name !== HERMES_PLUGIN_NAME)
  }
  next.plugins = plugins
  return next
}

export function updateConfigContent(
  content: string | null,
  updater: (config: HermesConfig) => HermesConfig
): { content: string | null; detail?: string } {
  const parsed = parseHermesConfig(content)
  if (!parsed.ok) {
    return { content: null, detail: parsed.detail }
  }
  return { content: serializeHermesConfig(updater(parsed.config)) }
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
