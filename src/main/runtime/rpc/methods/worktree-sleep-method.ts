import { WorktreeSleepParams } from '../../../../shared/rpc-contract/worktree-params'
import { defineMethod } from '../core'

export const WORKTREE_SLEEP_METHOD = defineMethod({
  name: 'worktree.sleep',
  permission: 'workspace',
  params: WorktreeSleepParams,
  // Each workspace's sleep queues itself, so this call must not queue again. A phone never reads
  // the reply, and the sleep can outlast its request timeout, so it is answered on acceptance.
  handler: async (params, { runtime, clientKind }) =>
    runtime.sleepManagedWorktree(params.worktree, {
      replyOnAcceptance: clientKind === 'mobile',
      markChatsAsleep: params.markChatsAsleep !== false
    })
})
