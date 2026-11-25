import { defineMethod } from '../../core'
import { WorktreeTabSelector } from '../../../../../shared/rpc-contract/session-tabs/session-tabs-schemas-params'

export const SESSION_TAB_SHELL_CHOICE_METHODS = [
  // The Windows shells a paired client may offer for a new terminal in this workspace.
  defineMethod({
    name: 'session.tabs.terminalShellChoices',
    permission: 'workspace',
    share: 'not-shared',
    params: WorktreeTabSelector,
    handler: async (params, { runtime }) => ({
      shells: await runtime.listMobileSessionTerminalShellChoices(params.worktree)
    })
  })
]
