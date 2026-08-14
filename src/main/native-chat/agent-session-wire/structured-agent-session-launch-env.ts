import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

type LaunchEnvResolver = (
  provider: AgentSessionRecord['provider']
) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined

export async function pinnedAgentSessionLaunchEnv(
  resolver: LaunchEnvResolver | undefined,
  params: AgentSessionAttachParams
): Promise<{ launchEnv: Record<string, string> } | Record<string, never>> {
  if (!resolver) {
    return {}
  }
  return {
    launchEnv: {
      ...(await resolver(params.provider)),
      [params.accountHome.variable]: params.accountHome.path
    }
  }
}
