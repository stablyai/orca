import type {
  ForceDeleteWorktreeBranchResult,
  RemoveWorktreeResult
} from '../../shared/worktree/create-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { preservedBranchCleanupScopeKey } from '../../shared/preserved-branch-cleanup'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { forceDeleteLocalBranch } from '../git/worktree'
import { gitExecFileAsync } from '../git/runner'
import {
  cleanupUnusedWorktreePushTargetRemote,
  cleanupUnusedWorktreePushTargetRemoteSsh
} from '../ipc/worktree-remote'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import type { Store } from '../persistence'
import { resolveWorktreeRemovalRepoOwner } from '../worktree-removal-repo-owner'
import { parseExactWorktreeIdSelector } from './runtime-worktree-selection'

type PreservedBranchCleanupTarget = {
  worktreeId: string
  hostId?: ExecutionHostId
  branchName: string
  head: string
  pushTarget?: GitPushTarget
}

export class RuntimePreservedBranchCleanup {
  private readonly targets = new Map<string, PreservedBranchCleanupTarget>()

  constructor(private readonly getStore: () => Store | null) {}

  remember(
    worktreeId: string,
    hostId: ExecutionHostId | undefined,
    result: RemoveWorktreeResult | undefined,
    fallbackHead: string | undefined,
    pushTarget: GitPushTarget | undefined
  ): void {
    if (result?.preservedBranch) {
      const head = result.preservedBranch.head ?? fallbackHead
      if (!head) {
        throw new Error(
          `Cannot safely offer force-delete for preserved branch "${result.preservedBranch.branchName}" without its saved commit.`
        )
      }
      this.targets.set(preservedBranchCleanupScopeKey({ worktreeId, hostId }), {
        worktreeId,
        ...(hostId ? { hostId } : {}),
        branchName: result.preservedBranch.branchName,
        head,
        ...(pushTarget ? { pushTarget } : {})
      })
      return
    }
    this.delete(worktreeId, hostId)
  }

  delete(worktreeId: string, hostId?: ExecutionHostId): void {
    this.targets.delete(preservedBranchCleanupScopeKey({ worktreeId, hostId }))
  }

  preserveHead(
    result: RemoveWorktreeResult | undefined,
    fallbackHead: string | undefined
  ): RemoveWorktreeResult {
    if (!result?.preservedBranch || result.preservedBranch.head || !fallbackHead) {
      return result ?? {}
    }
    return {
      ...result,
      preservedBranch: { ...result.preservedBranch, head: fallbackHead }
    }
  }

  async forceDelete(
    worktreeSelector: string,
    branchName: string,
    expectedHead: string,
    hostId?: string
  ): Promise<ForceDeleteWorktreeBranchResult> {
    const store = this.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    const removalTarget = parseExactWorktreeIdSelector(worktreeSelector)
    const normalizedHostId = parseExecutionHostId(hostId)?.id
    const exactTarget = removalTarget
      ? this.targets.get(
          preservedBranchCleanupScopeKey({ worktreeId: removalTarget.id, hostId: normalizedHostId })
        )
      : undefined
    const legacyMatches =
      removalTarget && !hostId
        ? [...this.targets.values()].filter(
            (target) =>
              target.worktreeId === removalTarget.id &&
              target.branchName === branchName &&
              target.head === expectedHead
          )
        : []
    const target = exactTarget ?? (legacyMatches.length === 1 ? legacyMatches[0] : undefined)
    if (
      !removalTarget ||
      !target ||
      target.branchName !== branchName ||
      target.head !== expectedHead
    ) {
      throw new Error(`No preserved branch cleanup is pending for "${branchName}".`)
    }
    const repoOwner = resolveWorktreeRemovalRepoOwner(store, removalTarget.repoId, target.hostId)
    if (repoOwner.kind === 'ambiguous') {
      throw new Error(
        `Workspace identity is ambiguous across hosts: ${removalTarget.id}. Retry with an explicit host.`
      )
    }
    const repo = repoOwner.kind === 'resolved' ? repoOwner.repo : undefined
    if (!repo) {
      throw new Error('repo_not_found')
    }
    if (isFolderRepo(repo)) {
      throw new Error('Folder workspaces do not have local Git branches.')
    }

    if (repo.connectionId) {
      const provider = requireSshGitProvider(repo.connectionId)
      await provider.forceDeletePreservedBranch(repo.path, target.branchName, target.head)
      await cleanupUnusedWorktreePushTargetRemoteSsh(
        provider,
        repo.path,
        removalTarget.id,
        target.pushTarget,
        store
      )
    } else {
      const options = getLocalProjectWorktreeGitOptions(store, repo)
      await (Object.keys(options).length > 0
        ? forceDeleteLocalBranch(repo.path, target.branchName, target.head, (argv, cwd) =>
            gitExecFileAsync(argv, { cwd, ...options })
          )
        : forceDeleteLocalBranch(repo.path, target.branchName, target.head))
      await cleanupUnusedWorktreePushTargetRemote(
        repo.path,
        removalTarget.id,
        target.pushTarget,
        store,
        options
      )
    }
    this.delete(removalTarget.id, target.hostId)
    return { deleted: true }
  }
}
