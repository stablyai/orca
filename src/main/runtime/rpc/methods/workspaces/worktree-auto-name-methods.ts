import {
  WorktreeAutoNameParams,
  WorktreeAutoNameWaitParams
} from '../../../../../shared/rpc-contract/workspaces/worktree-params'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import {
  firstWorkDismissDeps,
  firstWorkRenameDeps,
  firstWorkRetryDeps
} from '../../../../agent-hooks/first-work/first-work-rename-runtime'
import {
  getFirstWorkRetryAvailability,
  retryFirstWorkRename
} from '../../../../agent-hooks/first-work/first-work-rename-retry'
import { dismissFirstWorkRename } from '../../../../agent-hooks/first-work/first-work-rename-dismiss'
import { waitForFirstWorkAttempt } from '../../../../agent-hooks/first-work/first-work-rename-attempts'
import { AUTO_NAME_RPC_METHODS } from '../../../../../shared/worktree/branch-auto-rename-attempt'
import { defineMethod } from '../../core'

// A paired client's Try again and Dismiss: the same local actions, run against this host's store.
export const WORKTREE_AUTO_NAME_METHODS = [
  defineMethod({
    name: AUTO_NAME_RPC_METHODS.availability,
    permission: 'workspace',
    params: WorktreeAutoNameParams,
    handler: (params, { runtime }) =>
      getFirstWorkRetryAvailability(
        params.worktreeId,
        LOCAL_EXECUTION_HOST_ID,
        firstWorkRenameDeps(runtime.requireStore(), runtime)
      )
  }),
  defineMethod({
    name: AUTO_NAME_RPC_METHODS.retry,
    permission: 'workspace',
    params: WorktreeAutoNameParams,
    handler: (params, { runtime }) =>
      retryFirstWorkRename(params.worktreeId, firstWorkRetryDeps(runtime.requireStore(), runtime))
  }),
  defineMethod({
    name: AUTO_NAME_RPC_METHODS.dismiss,
    permission: 'workspace',
    params: WorktreeAutoNameParams,
    handler: async (params, { runtime }) =>
      dismissFirstWorkRename(
        params.worktreeId,
        firstWorkDismissDeps(runtime.requireStore(), runtime)
      )
  }),
  defineMethod({
    name: AUTO_NAME_RPC_METHODS.wait,
    permission: 'workspace',
    params: WorktreeAutoNameWaitParams,
    handler: async (params) =>
      (await waitForFirstWorkAttempt(params.worktreeId, params.attemptId)) ?? null
  })
]
