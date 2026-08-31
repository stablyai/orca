import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

type LaunchEnvResolver = (
  provider: AgentSessionRecord['provider']
) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined

type LaunchArgsResolver = (
  provider: AgentSessionRecord['provider']
) => Promise<string[] | undefined> | string[] | undefined

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

export async function pinnedAgentSessionLaunchArgs(
  resolver: LaunchArgsResolver | undefined,
  params: AgentSessionAttachParams
): Promise<{ launchArgs: string[] } | Record<string, never>> {
  const launchArgs = await resolver?.(params.provider)
  return launchArgs ? { launchArgs: [...launchArgs] } : {}
}
