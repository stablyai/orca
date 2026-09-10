import {
  applyManagedCliContextEnv,
  stripManagedCliContextEnvKeys
} from './runtime-managed-cli-environment'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import type { ManagedCliContext } from '../../shared/managed-cli-context'

type ManagedTerminalSpawnRuntime = {
  buildTerminalWorkspaceEnv: (
    workspace: unknown,
    env: Record<string, string>,
    paneKey: string,
    tabId: string,
    agentTeamsEnv?: Record<string, string>
  ) => Record<string, string>
  buildManagedCliContextForSpawn: (args: {
    connectionId: string | null
    worktreeId: string
    terminalHandle: string
  }) => ManagedCliContext
}

export function buildManagedTerminalSpawnEnvironment(params: {
  runtime: ManagedTerminalSpawnRuntime
  workspace: { id: string; connectionId: string | null }
  baseEnv: Record<string, string>
  sequencedStartupCommand?: string
  paneKey: string
  tabId: string
  agentTeamsEnv?: Record<string, string>
  orchestrationManagedLaunch?: boolean
  terminalHandle: string
}): Record<string, string> {
  const rawEnv = params.runtime.buildTerminalWorkspaceEnv(
    params.workspace,
    {
      ...params.baseEnv,
      ...(params.sequencedStartupCommand
        ? { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: params.sequencedStartupCommand }
        : {})
    },
    params.paneKey,
    params.tabId,
    params.agentTeamsEnv
  )
  return params.orchestrationManagedLaunch
    ? applyManagedCliContextEnv(
        rawEnv,
        params.runtime.buildManagedCliContextForSpawn({
          connectionId: params.workspace.connectionId,
          worktreeId: params.workspace.id,
          terminalHandle: params.terminalHandle
        })
      )
    : stripManagedCliContextEnvKeys(rawEnv)
}
