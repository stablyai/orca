import { prepareManagedWslCodexHomeBeforeShellLaunch } from '../../../codex/managed-wsl-home-shell-preflight'
import { defineMethod } from '../core'
import { CANVAS_AGENT_CONTEXT_METHODS } from './canvas-agent-context'
import { CANVAS_MESSAGING_METHODS } from './canvas-messaging'
import { PrepareCodexForWslPaneParams } from '../../../../shared/rpc-contract/agent-hooks-params'

export const AGENT_HOOK_METHODS = [
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
  }),
  ...CANVAS_AGENT_CONTEXT_METHODS,
  ...CANVAS_MESSAGING_METHODS
]
