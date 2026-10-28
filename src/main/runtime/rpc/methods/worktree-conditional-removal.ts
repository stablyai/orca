import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'
import { ConditionalWorktreeRemoval } from '../../../../shared/rpc-contract/conditional-worktree-removal'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { defineMethod } from '../core'

export const WORKTREE_CONDITIONAL_REMOVAL_METHODS = [
  defineMethod({
    name: 'worktree.removalCapabilities',
    permission: 'workspace',
    params: null,
    handler: async () => ({
      conditionalIdleRemoval:
        ORCA_LAYOUT_OWNER_IS_MAIN && ORCA_SIDEBAR_INPUTS_IS_MAIN && process.platform !== 'win32'
          ? 'native-git-local-v1'
          : 'unsupported',
      requiresMainOwnedLayout: true,
      stopsSessions: false,
      preservesLocalBranch: true
    })
  }),
  defineMethod({
    name: 'worktree.removeIfIdle',
    permission: 'workspace',
    params: ConditionalWorktreeRemoval,
    handler: async (params, { runtime }) => runtime.removeManagedWorktreeIfIdle(params)
  })
]
