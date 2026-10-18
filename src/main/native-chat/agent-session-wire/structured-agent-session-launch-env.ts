import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'

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
      ...(isLegacyAgentSessionAccountHome(params.accountHome)
        ? { [params.accountHome.variable]: params.accountHome.path }
        : {})
    }
  }
}

export async function pinnedAgentSessionLaunchArgs(
  resolver: LaunchArgsResolver | undefined,
  params: AgentSessionAttachParams
): Promise<{ launchArgs: string[] } | Record<string, never>> {
  const launchArgs = params.launchArgs ?? (await resolver?.(params.provider))
  return launchArgs ? { launchArgs: [...launchArgs] } : {}
}

/** The model and effort the chat was created with, which its opening message runs on as a send's
 *  carried ones do. */
export function openingMessageOptions(options: Readonly<Record<string, string>> | undefined): {
  options?: Readonly<Record<string, string>>
} {
  const { model, effort } = options ?? {}
  return model ? { options: { model, ...(effort ? { effort } : {}) } } : {}
}
