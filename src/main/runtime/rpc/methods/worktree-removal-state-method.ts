import { defineMethod } from '../core'
import { resolvePairedCallerHostId } from './paired-caller-host-id'
import { WorktreeRemovalStateParams } from './worktree-schemas'

export const WORKTREE_REMOVAL_STATE_METHODS = [
  // Why a read, not a held `worktree.rm`: a caller waiting out a long delete polls this, so it holds
  // no connection or long-poll slot while Git works.
  defineMethod({
    name: 'worktree.removalState',
    permission: 'workspace',
    params: WorktreeRemovalStateParams,
    handler: async (params, { runtime }) =>
      runtime.readWorktreeRemovalState(
        params.worktreeId,
        // Same host spelling worktree.rm acted on, or a paired caller reads the wrong host.
        resolvePairedCallerHostId(
          () => runtime.listRepos(),
          `id:${params.worktreeId}`,
          params.hostId
        )
      )
  })
]
