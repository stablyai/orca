import { defineMethod } from '../core'
import {
  PrFollowUpsRead,
  PrFollowUpsStop
} from '../../../../shared/rpc-contract/pr-follow-up-params'

export const PR_FOLLOW_UP_METHODS = [
  defineMethod({
    name: 'prFollowUps.get',
    permission: 'workspace',
    params: PrFollowUpsRead,
    handler: ({ worktreeId }, { runtime }) => ({
      available: Boolean(runtime.prFollowUps),
      workspaces: runtime.prFollowUps
        ? worktreeId
          ? { [worktreeId]: runtime.prFollowUps.forWorkspace(worktreeId) }
          : runtime.prFollowUps.snapshot()
        : {}
    })
  }),
  defineMethod({
    name: 'prFollowUps.stop',
    permission: 'settings-write',
    params: PrFollowUpsStop,
    handler: async ({ worktreeId, stopped }, { runtime }) => {
      const current = runtime.prFollowUps?.forWorkspace(worktreeId)
      if (current) {
        await runtime.prFollowUps?.stop(current.prKey, stopped)
      }
      return {
        available: Boolean(runtime.prFollowUps),
        ...runtime.prFollowUps?.forWorkspace(worktreeId)
      }
    }
  })
]
