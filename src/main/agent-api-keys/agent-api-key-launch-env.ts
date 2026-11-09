import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../shared/execution-host'

/** Installed only by the desktop: a host (orcad) never holds the user's vault, so its launches get nothing here. */
export type AgentApiKeyLaunchEnvResolver = (
  agent: TuiAgent,
  hostId: ExecutionHostId
) => Promise<Record<string, string>>

let installed: AgentApiKeyLaunchEnvResolver | null = null

export function installAgentApiKeyLaunchEnvResolver(
  resolver: AgentApiKeyLaunchEnvResolver | null
): void {
  installed = resolver
}

export async function resolveAgentApiKeyLaunchEnv(
  agent: TuiAgent | undefined,
  hostId: ExecutionHostId
): Promise<Record<string, string>> {
  if (!agent || !installed) {
    return {}
  }
  try {
    return await installed(agent, hostId)
  } catch {
    // A vault fault must not fail the launch; the agent falls back to its own sign-in.
    console.warn('[agent-api-keys] Could not read stored keys; launching without them')
    return {}
  }
}

/** `env` with the stored keys for this agent process; the caller's own env (an agent command override's VAR=…) still wins. */
export async function withAgentApiKeyLaunchEnv(
  env: Record<string, string> | undefined,
  agent: TuiAgent | undefined,
  hostId: ExecutionHostId
): Promise<Record<string, string> | undefined> {
  const keys = await resolveAgentApiKeyLaunchEnv(agent, hostId)
  return Object.keys(keys).length === 0 ? env : { ...keys, ...env }
}
