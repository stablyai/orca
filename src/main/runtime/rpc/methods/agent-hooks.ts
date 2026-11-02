import { isAgentStatusHooksEnabledForAgent } from '../../../../shared/agent-status-hooks-setting'
import { prepareManagedWslCodexHomeBeforeShellLaunch } from '../../../codex/managed-wsl-home-shell-preflight'
import { defineMethod } from '../core'
import {
  PrepareCodexForWslPaneParams,
  SavedRestoreCheckParams
} from '../../../../shared/rpc-contract/agent-hooks-params'
import {
  completeSavedRestoreFresh,
  decideSavedRestore
} from '../../../ipc/pty/saved-resume-fresh/saved-restore-receipt'

export const AGENT_HOOK_METHODS = [
  defineMethod({
    name: 'agentHooks.prepareCodexForWslPane',
    permission: 'workspace',
    params: PrepareCodexForWslPaneParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Codex hook preparation is only available to the local Orca CLI.')
      }
      return await prepareManagedWslCodexHomeBeforeShellLaunch({
        env: {
          CODEX_HOME: params.codexHome,
          ORCA_CODEX_HOME: params.orcaCodexHome,
          WSL_DISTRO_NAME: params.wslDistro
        },
        hooksEnabled: isAgentStatusHooksEnabledForAgent(
          runtime.requireStore().getSettings(),
          'codex'
        )
      })
    }
  }),
  defineMethod({
    name: 'agentHooks.savedRestore',
    permission: 'workspace',
    params: SavedRestoreCheckParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Saved restore checks are only available to the local Orca CLI.')
      }
      if (params.phase === 'dispatched') {
        completeSavedRestoreFresh(params.token, runtime)
        return { fresh: false }
      }
      return { fresh: (await decideSavedRestore(params)) === 'fresh' }
    }
  })
]
