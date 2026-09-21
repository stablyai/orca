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
import { getSshPtyProvider, getLocalPtyProvider, clearProviderPtyState } from '../../pty'
import { killAllProcessesForWorktree } from '../../../runtime/worktree-teardown'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import {
  notifyWorktreesChanged,
  cleanupUnusedWorktreePushTargetRemoteSsh,
  cleanupUnusedWorktreePushTargetRemote
} from '../../worktree-remote'
import { requireSshGitProvider } from '../../../providers/ssh-git-dispatch'
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
      // Repo-first (unlike owner resolution below) so this key matches worktrees:remove's; meta only covers ownerless forgets.
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
        const sshPtyProvider =
          ownerHost?.kind === 'ssh' ? getSshPtyProvider(ownerHost.targetId) : undefined
        const externalHost = ownerHost?.kind === 'ssh' || ownerHost?.kind === 'runtime'
        // External host inventories must never sweep a same-id local workspace.
        await killAllProcessesForWorktree(args.worktreeId, {
          runtime,
          resolvedWorktreeId: args.worktreeId,
          ...(ownerHost?.kind === 'ssh' ? { resolvedConnectionId: ownerHost.targetId } : {}),
          ...(ownerHost?.kind === 'runtime'
            ? { resolvedRuntimeEnvironmentId: ownerHost.environmentId }
            : {}),
          localProvider: sshPtyProvider ?? getLocalPtyProvider(),
          onPtyStopped: clearProviderPtyState,
          ...(externalHost
            ? {
                includeProviderInventory: ownerHost?.kind === 'ssh' && Boolean(sshPtyProvider),
                includeLocalRegistry: false
              }
            : {})
        }).catch((err) => {
          console.warn(`[worktree-teardown] forget-local failed for ${args.worktreeId}:`, err)
        })

        runtime.clearOptimisticReconcileToken(args.worktreeId)
        // The resolved owner, not args.hostId: an orphan forget with no hostId still has to purge its SSH/runtime partition.
        removeWorktreeMetadataAndTransientState(
          store,
          args.worktreeId,
          ownerHost?.id,
          args.snapshotPruneBatchId
        )
        // Why: cached roots outlive the forgotten workspace, so an ownerless path stays filesystem-authorized until a rebuild.
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
      if (isFolderRepo(repo)) {
        throw new Error('Folder workspaces do not have local Git branches.')
      }

      if (repo.connectionId) {
        const provider = requireSshGitProvider(repo.connectionId)
        // Why: SSH needs the write-capable relay RPC; the read-only git.exec allowlist rejects these worktree/update-ref/config writes.
        await provider.forceDeletePreservedBranch(
          repo.path,
          cleanupTarget.branchName,
          cleanupTarget.head
        )
        await cleanupUnusedWorktreePushTargetRemoteSsh(
          provider,
          repo.path,
          args.worktreeId,
          cleanupTarget.pushTarget,
          store
        )
      } else {
        const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
        const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
        await (hasLocalWorktreeGitOptions
          ? forceDeleteLocalBranch(
              repo.path,
              cleanupTarget.branchName,
              cleanupTarget.head,
              (argv, cwd) => gitExecFileAsync(argv, { cwd, ...localWorktreeGitOptions })
            )
          : forceDeleteLocalBranch(repo.path, cleanupTarget.branchName, cleanupTarget.head))
        await cleanupUnusedWorktreePushTargetRemote(
          repo.path,
          args.worktreeId,
          cleanupTarget.pushTarget,
          store,
          localWorktreeGitOptions
        )
      }

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
