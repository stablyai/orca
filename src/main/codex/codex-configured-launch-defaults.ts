import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'

// Why short: config/read is a local file read; a slow answer must not hold the listing.
const CONFIG_READ_TIMEOUT_MS = 3_000

type CodexConfiguredLaunchDefaults = { model: string | null; effort: string | null }

function configuredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The model and effort the user's Codex config selects, or null when Codex can't say. */
export async function readCodexConfiguredLaunchDefaults(
  connection: Pick<CodexAppServerConnection, 'request'>
): Promise<CodexConfiguredLaunchDefaults | null> {
  try {
    const response = await connection.request(
      'config/read',
      {},
      { timeoutMs: CONFIG_READ_TIMEOUT_MS }
    )
    const config =
      typeof response === 'object' && response !== null && 'config' in response
        ? response.config
        : null
    if (typeof config !== 'object' || config === null) {
      return null
    }
    return {
      model: 'model' in config ? configuredText(config.model) : null,
      effort:
        'model_reasoning_effort' in config ? configuredText(config.model_reasoning_effort) : null
    }
  } catch {
    // Older Codex has no config/read; its own listing default then stands.
    return null
  }
}

/**
 * Re-points the listing's default at what a launch without an explicit pick
 * actually runs: `model/list` marks Codex's recommended model, but a launch
 * follows the user's configured model and effort.
 */
export function applyCodexConfiguredLaunchDefaults(
  models: AgentSessionModelOption[],
  configured: CodexConfiguredLaunchDefaults | null
): AgentSessionModelOption[] {
  const configuredModel = configured?.model
    ? models.find((model) => model.id === configured.model)
    : undefined
  if (configured?.model && !configuredModel) {
    // Codex runs a configured model the listing omits, so no listed row is what a launch runs.
    return models.map((model) => ({ ...model, isDefault: false }))
  }
  const defaultModel = configuredModel ?? models.find((model) => model.isDefault)
  const effort = configured?.effort ?? null
  const defaultEffort =
    effort && defaultModel?.efforts.some((choice) => choice.value === effort) ? effort : null
  if (!configuredModel && !defaultEffort) {
    return models
  }
  return models.map((model) => {
    const isDefault = model === defaultModel
    return isDefault && defaultEffort
      ? { ...model, isDefault, defaultEffort }
      : { ...model, isDefault }
  })
}
