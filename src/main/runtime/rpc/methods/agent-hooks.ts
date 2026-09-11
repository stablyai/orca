import { prepareManagedWslCodexHomeBeforeShellLaunch } from '../../../codex/managed-wsl-home-shell-preflight'
import { defineMethod, type RpcMethod } from '../core'
import { PrepareCodexForWslPaneParams } from '../../../../shared/rpc-contract/agent-hooks-params'

export const AGENT_HOOK_METHODS: readonly RpcMethod[] = [
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
