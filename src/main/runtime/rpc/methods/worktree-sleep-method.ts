import { WorktreeSleepParams } from '../../../../shared/rpc-contract/worktree-params'
import { defineMethod } from '../core'

export const WORKTREE_SLEEP_METHOD = defineMethod({
  name: 'worktree.sleep',
  permission: 'workspace',
  params: WorktreeSleepParams,
  // Sleep owns each workspace queue; do not queue twice. Answer on acceptance because phones ignore replies and sleep may outlast timeout.
  handler: async (params, { runtime, clientKind }) =>
    runtime.sleepManagedWorktree(params.worktree, {
      replyOnAcceptance: clientKind === 'mobile',
      markChatsAsleep: params.markChatsAsleep !== false
    })
})
