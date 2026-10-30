import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'

// Permissions/hooks/MCP config does not invalidate defaults unless it can change models or efforts.

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function setsAny(table: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => table[key] !== undefined)
}

// Claude agent selection can apply its model to the main thread.
const CLAUDE_MODEL_SETTINGS = [
  'model',
  'agent',
  'effortLevel',
  'maxEffortLevel',
  'modelSettings',
  'availableModels',
  'enforceAvailableModels',
  'modelOverrides'
] as const

function isClaudeModelEnvKey(key: string): boolean {
  return (
    key === 'ANTHROPIC_MODEL' ||
    key === 'CLAUDE_CODE_EFFORT_LEVEL' ||
    /^ANTHROPIC_DEFAULT_([A-Z]+_)?MODEL$/.test(key) ||
    /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY|ANTHROPIC_AWS|ANTHROPIC_GOOGLE_CLOUD|MANTLE|GATEWAY)$/.test(
      key
    )
  )
}

/** Treat malformed settings as possible model overrides. */
export function claudeSettingsMayPickModel(text: string): boolean {
  let settings: Record<string, unknown> | null
  try {
    settings = record(JSON.parse(text))
  } catch {
    return true
  }
  if (!settings) {
    return true
  }
  if (setsAny(settings, CLAUDE_MODEL_SETTINGS)) {
    return true
  }
  const env = record(settings.env)
  return env !== null && Object.keys(env).some(isClaudeModelEnvKey)
}

const CODEX_MODEL_KEYS = ['model', 'model_reasoning_effort', 'model_provider'] as const

/** Treat malformed TOML and profile-based picks as possible model overrides. */
export function codexConfigMayPickModel(text: string): boolean {
  let config: Record<string, unknown>
  try {
    config = parseToml(text)
  } catch {
    return true
  }
  if (setsAny(config, CODEX_MODEL_KEYS) || config.profile !== undefined) {
    return true
  }
  const profiles = record(config.profiles)
  return (
    profiles !== null &&
    Object.values(profiles).some((profile) => {
      const table = record(profile)
      return table === null || setsAny(table, CODEX_MODEL_KEYS)
    })
  )
}

const OPENCODE_MODEL_KEYS = [
  'model',
  'default_agent',
  'provider',
  'providers',
  'enabled_providers',
  'disabled_providers'
] as const
const OPENCODE_AGENT_TABLES = ['agent', 'agents', 'mode'] as const
const OPENCODE_AGENT_MODEL_KEYS = ['model', 'variant', 'disable'] as const

/** Treat malformed JSONC as a possible model override. */
export function openCodeConfigMayPickModel(text: string): boolean {
  const errors: ParseError[] = []
  const config = record(parseJsonc(text, errors, { allowTrailingComma: true }))
  if (errors.length > 0 || !config) {
    return true
  }
  if (setsAny(config, OPENCODE_MODEL_KEYS)) {
    return true
  }
  return OPENCODE_AGENT_TABLES.some((key) => {
    if (config[key] === undefined) {
      return false
    }
    const agents = record(config[key])
    return (
      agents === null ||
      Object.values(agents).some((agent) => {
        const table = record(agent)
        return table === null || setsAny(table, OPENCODE_AGENT_MODEL_KEYS)
      })
    )
  })
}

/** Treat unreadable agent frontmatter as a possible model override. */
export function openCodeAgentFileMayPickModel(text: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) {
    return false
  }
  try {
    const frontmatter = record(parseYaml(match[1] ?? ''))
    return frontmatter !== null && setsAny(frontmatter, OPENCODE_AGENT_MODEL_KEYS)
  } catch {
    return true
  }
}

const OMP_MODEL_SETTINGS = [
  'modelRoles',
  'enabledModels',
  'disabledProviders',
  'modelProviderOrder',
  'modelTags',
  'providers',
  'defaultThinkingLevel',
  'defaultModel',
  'defaultProvider'
] as const

function setsOmpModelSetting(settings: Record<string, unknown>): boolean {
  return Object.keys(settings).some((key) =>
    OMP_MODEL_SETTINGS.some((setting) => key === setting || key.startsWith(`${setting}.`))
  )
}

/** Treat unparseable project settings as possible model/thinking-level overrides. */
export function ompSettingsMayPickModel(text: string, format: 'json' | 'yaml' | 'toml'): boolean {
  let settings: Record<string, unknown> | null
  try {
    const parsed: unknown =
      format === 'json' ? JSON.parse(text) : format === 'yaml' ? parseYaml(text) : parseToml(text)
    settings = parsed === null && format === 'yaml' ? {} : record(parsed)
  } catch {
    return true
  }
  return settings === null || setsOmpModelSetting(settings)
}

// Project extensions can register providers or change the model themselves.
const PI_MODEL_SETTINGS = [
  'defaultProvider',
  'defaultModel',
  'defaultThinkingLevel',
  'modelThinkingLevels',
  'enabledModels',
  'extensions',
  'packages'
] as const

export function piSettingsMayPickModel(text: string): boolean {
  // Match Pi's BOM and empty-file handling.
  const body = text.replace(/^\uFEFF/, '').trim()
  if (body === '') {
    return false
  }
  let settings: Record<string, unknown> | null
  try {
    settings = record(JSON.parse(body))
  } catch {
    return true
  }
  return settings === null || setsAny(settings, PI_MODEL_SETTINGS)
}
