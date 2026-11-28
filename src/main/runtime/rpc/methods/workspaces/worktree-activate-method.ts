import { WorktreeActivate } from '../../../../../shared/rpc-contract/workspaces/worktree-params'
import { resolveRuntimeNavigationTarget } from '../../../../../shared/remote-runtime/session-graph/runtime-navigation'
import { defineMethod } from '../../core'

export const WORKTREE_ACTIVATE_METHOD = defineMethod({
  name: 'worktree.activate',
  permission: 'workspace',
  params: WorktreeActivate,
  handler: async (params, { runtime, clientKind }) =>
    // Only mobile activation wakes host-renderer slept agents; preserve web/desktop behavior.
    runtime.activateManagedWorktree(params.worktree, {
      notifyClients: params.notifyClients !== false,
      clientKind,
      navigation: resolveRuntimeNavigationTarget({
        navigation: params.navigation,
        notifyClients: params.notifyClients,
        clientKind,
        defaultTarget: 'host'
      })
    })
})
