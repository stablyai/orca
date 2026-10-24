import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'

// Bound config reads so a slow app-server cannot hold the model listing.
const CONFIG_READ_TIMEOUT_MS = 3_000

type CodexConfiguredLaunchDefaults = {
  model: string | null
  effort: string | null
  personality?: string
  serviceTier?: string
}

function configuredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function readCodexConfiguredLaunchDefaults(
  connection: Pick<CodexAppServerConnection, 'request'>,
  timeoutMs = CONFIG_READ_TIMEOUT_MS,
  cwd?: string
): Promise<CodexConfiguredLaunchDefaults | null> {
  try {
    const response = await connection.request('config/read', cwd ? { cwd } : {}, {
      timeoutMs: Math.min(timeoutMs, CONFIG_READ_TIMEOUT_MS)
    })
    const config =
      typeof response === 'object' && response !== null && 'config' in response
        ? response.config
        : null
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      return null
    }
    if (
      Object.entries(config).some(
        ([key, value]) =>
          ['model', 'model_reasoning_effort', 'personality', 'service_tier'].includes(key) &&
          value != null &&
          typeof value !== 'string'
      )
    ) {
      return null
    }
    const personality = 'personality' in config ? configuredText(config.personality) : null
    const serviceTier = 'service_tier' in config ? configuredText(config.service_tier) : null
    return {
      ...(personality ? { personality } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      model: 'model' in config ? configuredText(config.model) : null,
      effort:
        'model_reasoning_effort' in config ? configuredText(config.model_reasoning_effort) : null
    }
  } catch {
    // Refusal and transport failure leave configuration unknown.
    return null
  }
}

/** Launches follow configured model/effort; model/list marks only Codex's recommendation. */
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
