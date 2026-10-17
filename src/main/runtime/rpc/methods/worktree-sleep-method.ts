import { WorktreeSleep } from '../../../../shared/rpc-contract/worktree-params'
import { defineMethod } from '../core'
import { resolvePairedCallerHostId } from './paired-caller-host-id'

export const WORKTREE_SLEEP_METHOD = defineMethod({
  name: 'worktree.sleep',
  permission: 'workspace',
  params: WorktreeSleep,
  handler: async (params, { runtime }) =>
    runtime.sleepManagedWorktree(
      params.worktree,
      resolvePairedCallerHostId(() => runtime.listRepos(), params.worktree, params.hostId)
    )
})
