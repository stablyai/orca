import { waitForPromiseWithSignal } from '../../../../../shared/concurrency/abort-signal-reason'
import { runApprovedCreatedWorktreeSetup } from '../../../workspaces/creation/created-worktree-approved-setup'
import { defineMethod } from '../../core'
import {
  WorktreeRunApprovedSetup,
  WorktreeStartupDraft
} from '../../../../../shared/rpc-contract/workspaces/worktree-params'

export const WORKTREE_SETUP_METHODS = [
  defineMethod({
    name: 'worktree.startupDraft',
    permission: 'workspace',
    params: WorktreeStartupDraft,
    handler: (params, { runtime, signal }) => {
      switch (params.action) {
        case 'list':
          return runtime.listWorktreeStartupDrafts()
        case 'read':
          return runtime.readWorktreeStartupDraft(params)
        case 'dismiss':
          return runtime.dismissWorktreeStartupDraft(params)
        case 'wait':
          return waitForPromiseWithSignal(
            Promise.resolve(runtime.waitForWorktreeStartupDraftOutcome(params)),
            signal
          )
        case 'release':
          return runtime.releaseUnclaimedWorktreeStartupDraft(params)
      }
    }
  }),
  defineMethod({
    name: 'worktree.runApprovedSetup',
    permission: 'workspace',
    params: WorktreeRunApprovedSetup,
    handler: async (params, { runtime }) =>
      runApprovedCreatedWorktreeSetup(runtime, params.worktree, params.approvedSetupHash, {
        wslUserAct: true
      })
  })
]
