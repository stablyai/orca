import {
  WorktreeArchive,
  WorktreeRestore
} from '../../../../../shared/rpc-contract/workspaces/worktree-params'
import {
  queueWorkspaceArchive,
  queueWorkspaceRestore
} from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { defineMethod } from '../../core'
import { resolvePairedCallerHostId } from '../pairing/paired-caller-host-id'

// Not on the mobile allowlist or in the CLI until archive ships (WORKSPACE_ARCHIVE_SUPPORTED).
export const WORKTREE_ARCHIVE_METHODS = [
  defineMethod({
    name: 'worktree.archive',
    permission: 'workspace',
    params: WorktreeArchive,
    handler: async (params, { runtime }) => {
      const hostId = resolvePairedCallerHostId(
        () => runtime.listRepos(),
        params.worktree,
        params.hostId
      )
      return queueWorkspaceArchive(runtime, params.worktree, hostId, () =>
        runtime.archiveManagedWorktree(params.worktree, hostId ? { hostId } : {})
      )
    }
  }),
  defineMethod({
    name: 'worktree.restore',
    permission: 'workspace',
    params: WorktreeRestore,
    handler: async (params, { runtime }) => {
      const hostId = resolvePairedCallerHostId(
        () => runtime.listRepos(),
        params.worktree,
        params.hostId
      )
      return queueWorkspaceRestore(runtime, params.worktree, hostId, () =>
        runtime.restoreArchivedWorktree(params.worktree, {
          ...(hostId ? { hostId } : {}),
          ...(params.setupDecision ? { setupDecision: params.setupDecision } : {})
        })
      )
    }
  })
]
