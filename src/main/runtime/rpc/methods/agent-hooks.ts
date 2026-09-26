import { prepareManagedWslCodexHomeBeforeShellLaunch } from '../../../codex/managed-wsl-home-shell-preflight'
import { getManagedAgentHookStatuses } from '../../../agent-hooks/managed-agent-hook-controls'
import { getActiveSshAgentHookInstallReports } from '../../../ipc/ssh'
import { defineMethod } from '../core'
import { PrepareCodexForWslPaneParams } from '../../../../shared/rpc-contract/agent-hooks-params'

export const AGENT_HOOK_METHODS = [
  defineMethod({
    // Why: SSH hook state belongs to the host running the agent. Only the
    // active runtime can report the relay sessions that installed those hooks.
    name: 'agentHooks.status',
    params: null,
    handler: () => ({
      local: getManagedAgentHookStatuses(),
      remotes: getActiveSshAgentHookInstallReports()
    })
  }),
  defineMethod({
    name: 'agentHooks.prepareCodexForWslPane',
    params: PrepareCodexForWslPaneParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Codex hook preparation is only available to the local Orca CLI.')
      }
      const settings = runtime.getClientSettings()
      return await prepareManagedWslCodexHomeBeforeShellLaunch({
        env: {
          CODEX_HOME: params.codexHome,
          ORCA_CODEX_HOME: params.orcaCodexHome,
          WSL_DISTRO_NAME: params.wslDistro
        },
        hooksEnabled:
          settings.agentStatusHooksEnabled && !settings.disabledTuiAgents.includes('codex')
      })
    }
  })
]
