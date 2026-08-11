import type { TuiAgent } from '../../shared/types'
import type { GlobalSettings } from '../../shared/types'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { readStoredDeepSeekApiKey } from './deepseek-api-key-store'

// Agents that read DEEPSEEK_API_KEY from their environment to reach DeepSeek's
// OpenAI-compatible API. Aider reads it natively (e.g. --model deepseek/deepseek-chat);
// OpenCode autoloads the DeepSeek provider from this var. Extend as more agents
// gain native env support.
export const DEEPSEEK_ENV_AGENTS: ReadonlySet<TuiAgent> = new Set<TuiAgent>(['aider', 'opencode'])

function safeReadStoredDeepSeekApiKey(): string | null {
  // A corrupt/undecryptable key file must never block an agent launch.
  try {
    return readStoredDeepSeekApiKey()
  } catch {
    return null
  }
}

/**
 * Main-process launch-env resolver. Wraps the shared per-agent env resolver and,
 * for DeepSeek-capable agents, injects the Orca-stored DEEPSEEK_API_KEY so the
 * key entered in Settings → Accounts reaches the agent process. A value the user
 * configured for the agent (agentDefaultEnv) always wins over the stored key, and
 * a real DEEPSEEK_API_KEY already in the parent process env is left untouched by
 * omission here (the PTY inherits it downstream of this record).
 */
export function resolveAgentLaunchEnv(
  agent: TuiAgent,
  configuredEnv: GlobalSettings['agentDefaultEnv'] | null | undefined
): Record<string, string> {
  const env = resolveTuiAgentLaunchEnv(agent, configuredEnv)
  if (!DEEPSEEK_ENV_AGENTS.has(agent) || env.DEEPSEEK_API_KEY) {
    return env
  }
  const storedKey = safeReadStoredDeepSeekApiKey()
  if (storedKey) {
    env.DEEPSEEK_API_KEY = storedKey
  }
  return env
}
