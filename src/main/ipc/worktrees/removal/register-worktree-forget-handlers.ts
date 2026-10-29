import { ipcMain } from 'electron'
import type {
  RemoveWorktreeResult,
  ForceDeleteWorktreeBranchResult
} from '../../../../shared/worktree/create-types'
import { parseWorktreeId } from '../../worktree-logic'
import { resolveWorktreeRemovalRepoOwner } from '../../../worktree-removal-repo-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getLocalPtyProvider } from '../../pty/provider/registry'
import { clearProviderPtyState } from '../../pty/provider/state-cleanup'
import { killAllProcessesForWorktree } from '../../../runtime/worktree-teardown'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import {
  notifyWorktreesChanged,
  cleanupUnusedWorktreePushTargetRemote
} from '../../worktree-remote'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { forceDeleteLocalBranch } from '../../../git/worktree'
import { gitExecFileAsync } from '../../../git/runner'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import { getWorktreeRemovalInFlightKey } from './worktree-removal-coordinator'
import { getFolderWorkspaceRootId } from '../folder-workspace-model'
import {
  removeWorktreeMetadataAndTransientState,
  resolveWorktreeRemovalOwnerHostId
} from './worktree-removal-ownership'
import { resolveRepoForExecutionHost } from '../repo-host-ownership'
import {
  getPreservedBranchCleanupTarget,
  preservedBranchCleanupByScope
} from './preserved-branch-cleanup'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  assertWslMoveProjectWritable,
  assertWslMoveRepoWritable,
  isWslMoveSourceHost
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { teardownStops } from '../../../runtime/owned-session-teardown-policy'

export function registerWorktreeForgetHandlers(context: WorktreeIpcContext): void {
  const { mainWindow, store, runtime, worktreeRemovalsInFlight } = context

  ipcMain.handle(
    'worktrees:forgetLocal',
    async (
      _event,
      args: Pick<RemoveWorktreeArgs, 'worktreeId' | 'hostId' | 'snapshotPruneBatchId'>
    ): Promise<RemoveWorktreeResult> => {
      const { repoId } = parseWorktreeId(args.worktreeId)
      const repoOwner = resolveWorktreeRemovalRepoOwner(store, repoId, args.hostId)
      if (!args.hostId && repoOwner.kind === 'ambiguous') {
        throw new Error(
          `Workspace identity is ambiguous across hosts: ${args.worktreeId}. Retry with an explicit host.`
        )
      }
      const repo = repoOwner.kind === 'resolved' ? repoOwner.repo : undefined
      if (repo) {
        assertWslMoveRepoWritable(store, repo)
      } else if (isWslMoveSourceHost(args.hostId)) {
        assertWslMoveProjectWritable(store, { repoId })
      }
      // Match removal's repo-first coalescing key; metadata identifies only ownerless forgets.
      const inFlightKey = getWorktreeRemovalInFlightKey(
        args.worktreeId,
        repo
          ? getRepoExecutionHostId(repo)
          : (args.hostId ?? store.getWorktreeMeta(args.worktreeId)?.hostId)
      )
      const optionsKey = 'forget-local'
      const inFlight = worktreeRemovalsInFlight.get(inFlightKey)
      if (inFlight) {
        if (inFlight.optionsKey === optionsKey) {
          return inFlight.promise
        }
        throw new Error(`Worktree deletion already in progress: ${args.worktreeId}`)
      }

      const forget = (async (): Promise<RemoveWorktreeResult> => {
        const isFolderRootOf = (candidate: Repo): boolean =>
          isFolderRepo(candidate) && args.worktreeId === getFolderWorkspaceRootId(candidate)
        const fallbackRepos = args.hostId
          ? store
              .getRepos()
              .filter((candidate) => getRepoExecutionHostId(candidate) === args.hostId)
          : store.getRepos()
        if (repo ? isFolderRootOf(repo) : fallbackRepos.some(isFolderRootOf)) {
          throw new Error(
            'Cannot delete the project root workspace. Remove the folder project instead.'
          )
        }

        const ownerHostId = resolveWorktreeRemovalOwnerHostId(
          store,
          args.worktreeId,
          repo,
          args.hostId
        )
        const ownerHost = parseExecutionHostId(ownerHostId)
        const externalHost = ownerHost?.kind === 'ssh' || ownerHost?.kind === 'runtime'
        // Off-host teardown must never include same-ID local inventory.
        await killAllProcessesForWorktree(args.worktreeId, {
          runtime,
          resolvedWorktreeId: args.worktreeId,
          ...(ownerHost?.kind === 'ssh' ? { resolvedConnectionId: ownerHost.targetId } : {}),
          ...(ownerHost?.kind === 'runtime'
            ? { resolvedRuntimeEnvironmentId: ownerHost.environmentId }
            : {}),
          localProvider: getLocalPtyProvider(),
          onPtyStopped: clearProviderPtyState,
          // Metadata removal must retire structured chats even when no provider child is attached.
          closeStructuredSessions: teardownStops('worktree-removal', 'structured-chat'),
          ...(externalHost ? { includeProviderInventory: false, includeLocalRegistry: false } : {})
        }).catch((err) => {
          console.warn(`[worktree-teardown] forget-local failed for ${args.worktreeId}:`, err)
        })

        runtime.clearOptimisticReconcileToken(args.worktreeId)
        // Resolve omitted hosts too, or orphan cleanup purges the local partition and leaves remote state.
        removeWorktreeMetadataAndTransientState(
          { store, runtime },
          args.worktreeId,
          ownerHost?.id,
          args.snapshotPruneBatchId
        )
        // Cached authorization outlives metadata; invalidate it before the forgotten path can remain accessible.
        invalidateAuthorizedRootsCache()
        if (ownerHost?.id) {
          preservedBranchCleanupByScope.delete(
            preservedBranchCleanupScopeKey({ worktreeId: args.worktreeId, hostId: ownerHost.id })
          )
        } else {
          for (const [key, target] of preservedBranchCleanupByScope) {
            if (target.worktreeId === args.worktreeId) {
              preservedBranchCleanupByScope.delete(key)
            }
          }
        }
        notifyWorktreesChanged(mainWindow, repoId)
        return {}
      })()
      worktreeRemovalsInFlight.set(inFlightKey, { optionsKey, promise: forget })
      try {
        return await forget
      } finally {
        if (worktreeRemovalsInFlight.get(inFlightKey)?.promise === forget) {
          worktreeRemovalsInFlight.delete(inFlightKey)
        }
      }
    }
  )

  ipcMain.handle(
    'worktrees:forceDeletePreservedBranch',
    async (
      _event,
      args: {
        worktreeId: string
        branchName: string
        expectedHead: string
        hostId?: ExecutionHostId
      }
    ): Promise<ForceDeleteWorktreeBranchResult> => {
      const { repoId } = parseWorktreeId(args.worktreeId)
      const cleanupTarget = getPreservedBranchCleanupTarget(
        args.worktreeId,
        args.branchName,
        args.expectedHead,
        args.hostId
      )
      const repo = resolveRepoForExecutionHost(store, repoId, cleanupTarget.hostId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }
      assertWslMoveRepoWritable(store, repo)
      if (isFolderRepo(repo)) {
        throw new Error('Folder workspaces do not have local Git branches.')
      }

      if (repo.connectionId) {
        throw new SshHostNotServedError(repo.connectionId)
      }
      const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
      const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
      await (hasLocalWorktreeGitOptions
        ? forceDeleteLocalBranch(
            repo.path,
            cleanupTarget.branchName,
            cleanupTarget.head,
            (argv, cwd) => gitExecFileAsync(argv, { cwd, ...localWorktreeGitOptions }),
            localWorktreeGitOptions
          )
        : forceDeleteLocalBranch(repo.path, cleanupTarget.branchName, cleanupTarget.head))
      await cleanupUnusedWorktreePushTargetRemote(
        repo.path,
        args.worktreeId,
        cleanupTarget.pushTarget,
        store,
        localWorktreeGitOptions
      )

      preservedBranchCleanupByScope.delete(
        preservedBranchCleanupScopeKey({
          worktreeId: args.worktreeId,
          hostId: cleanupTarget.hostId
        })
      )
      return { deleted: true }
    }
  )
}
