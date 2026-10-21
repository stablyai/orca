import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'

// Which keys in a project's own agent config can move a new chat off the account's model or
// effort. A file that sets none (permissions, hooks, MCP servers) leaves the account default.

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function setsAny(table: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => table[key] !== undefined)
}

// Claude settings keys that pick the model, its effort or effort cap, or which models Default may
// resolve to; `agent` applies that agent's model to the main thread.
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

/** The model, alias-target and effort env vars Claude Code reads, plus the provider switches
 *  that change which model ids exist at all. */
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

/** True when a Claude settings file's text could pick a model or effort; unreadable JSON counts. */
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

/** True when a Codex `config.toml`'s text could pick a model or effort, directly or through a
 *  profile; unparseable TOML counts. */
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

// OpenCode config keys (1.x and 2.x schemas) that pick the chat's model or effort, or the providers
// a model-less config picks its default from.
const OPENCODE_MODEL_KEYS = [
  'model',
  'default_agent',
  'provider',
  'providers',
  'enabled_providers',
  'disabled_providers'
] as const
// Tables of agents, each of which may carry its own model or variant (effort), or turn one off.
const OPENCODE_AGENT_TABLES = ['agent', 'agents', 'mode'] as const
const OPENCODE_AGENT_MODEL_KEYS = ['model', 'variant', 'disable'] as const

/** True when an `opencode.json(c)`'s text could pick a model or effort; invalid JSONC counts. */
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

/** True when an OpenCode agent file's frontmatter could pick a model or effort; unreadable counts. */
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

// OMP settings that pick the model (its role models, the models and providers it may choose
// from) or its thinking level, plus the older Pi names for the same.
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

/** True when a settings file OMP merges into its project settings could pick a model or
 *  thinking level; one it can't parse counts. `format` is the file's syntax. */
export function ompSettingsMayPickModel(text: string, format: 'json' | 'yaml' | 'toml'): boolean {
  let settings: Record<string, unknown> | null
  try {
    const parsed: unknown =
      format === 'json' ? JSON.parse(text) : format === 'yaml' ? parseYaml(text) : parseToml(text)
    // An empty YAML file is no settings.
    settings = parsed === null && format === 'yaml' ? {} : record(parsed)
  } catch {
    return true
  }
  return settings === null || setsOmpModelSetting(settings)
}

// Pi settings that pick the startup model or thinking level, or load project extension code, which
// may register providers or set the model itself.
const PI_MODEL_SETTINGS = [
  'defaultProvider',
  'defaultModel',
  'defaultThinkingLevel',
  'modelThinkingLevels',
  'enabledModels',
  'extensions',
  'packages'
] as const

/** True when a Pi `.pi/settings.json`'s text could pick a model or thinking level; one Pi can't
 *  parse counts. */
export function piSettingsMayPickModel(text: string): boolean {
  // Pi drops a leading BOM and reads an empty file as no settings.
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
