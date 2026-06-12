import { existsSync, readFileSync } from 'fs'
import { parse as parseJsonc } from 'jsonc-parser'
import { isPlainObject, type HooksConfig } from '../agent-hooks/installer-utils'

/** Devin documents config.json as JSONC; stock JSON.parse rejects comments. */
export function readDevinHooksConfig(configPath: string): HooksConfig | null {
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const text = readFileSync(configPath, 'utf-8')
    const parsed = parseJsonc(text)
    if (parsed === undefined) {
      return null
    }
    return isPlainObject(parsed) ? (parsed as HooksConfig) : null
  } catch {
    return null
  }
}

const ORCA_MANAGED_AGENT_IDS: Record<string, true> = {
  claude: true,
  openclaude: true,
  codex: true,
  gemini: true,
  cursor: true,
  copilot: true,
  grok: true,
  devin: true
}

/** Devin `read_config_from` can duplicate Orca-managed hooks from other agents. */
export function readConfigFromOrcaOverlapDetail(
  config: HooksConfig & { read_config_from?: unknown }
): string | null {
  const raw = config.read_config_from
  if (!Array.isArray(raw)) {
    return null
  }
  const overlaps = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => entry in ORCA_MANAGED_AGENT_IDS)
  if (overlaps.length === 0) {
    return null
  }
  return `Devin read_config_from (${overlaps.join(', ')}) may fire duplicate Orca hook posts alongside Devin hooks.`
}

export function mergeHookInstallDetail(
  base: string | null,
  extra: string | null
): string | null {
  if (!extra) {
    return base
  }
  if (!base) {
    return extra
  }
  return `${base} ${extra}`
}