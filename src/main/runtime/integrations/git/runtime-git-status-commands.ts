import type {
  GitHistoryOptions,
  GitHistoryResult
} from '../../../../shared/git/history/git-history-types'
import type { GitMutationInFlight } from '../../../../shared/git/commands/git-mutation-in-flight'
import { isGitWorktreeMutationInFlight } from '../../../git/command-runner/git-worktree-mutation-state'
import type { BranchSwitchTarget } from '../../../../shared/git/branch-switch-target'
import {
  BranchSwitchLandedWithWarningError,
  switchBranchGuarded
} from '../../../git/worktrees/checkout/branch-switch'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult
} from '../../../../shared/git/status/git-status-types'
import type {
  RuntimeGitSwitchResult,
  RuntimeGitCheckoutResult,
  RuntimeGitLocalBranches
} from '../../../../shared/runtime-worktree-contracts'
import type { GitProviderStatusOptions } from '../../../providers/git/status-options'
import {
  localGitOptionsForTarget,
  requireLocalRuntimeGitRoute,
  requireRuntimeGitProvider,
  type RuntimeGitCommandHost,
  type RuntimeGitTarget
} from './runtime-git-command-target'
import { assertRuntimeReadWslDistroRunning } from './runtime-wsl-background-read-gate'
import type { WorktreeAtRiskLocalFiles } from '../../../../shared/worktree/removal/at-risk-local-files'
import { readWorktreeAtRiskLocalFiles } from '../../../git/worktrees/removal/worktree-at-risk-local-files'

// Followers nobody is looking at: a stopped distro must stay stopped for them (E9).
async function resolveGatedGitTarget(
  host: RuntimeGitCommandHost,
  worktreeSelector: string
): Promise<RuntimeGitTarget> {
  const target = await host.resolveRuntimeGitTarget(worktreeSelector)
  await assertRuntimeReadWslDistroRunning(target, localGitOptionsForTarget(target).wslDistro)
  return target
}

export class RuntimeGitStatusCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async getRuntimeGitStatus(
    worktreeSelector: string,
    options?: GitProviderStatusOptions
  ): Promise<GitStatusResult> {
    // A client showing this workspace is a user act; its status is the implicit wake (E9).
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    return options
      ? provider.getStatus(target.worktree.path, options)
      : provider.getStatus(target.worktree.path)
  }

  async getRuntimeGitSubmoduleStatus(
    worktreeSelector: string,
    submodulePath: string,
    area: GitStagingArea = 'unstaged'
  ): Promise<GitStatusResult> {
    const target = await resolveGatedGitTarget(this.host, worktreeSelector)
    return requireRuntimeGitProvider(target).getSubmoduleStatus(
      target.worktree.path,
      submodulePath,
      area
    )
  }

  async checkRuntimeGitIgnoredPaths(
    worktreeSelector: string,
    relativePaths: string[]
  ): Promise<string[]> {
    const target = await resolveGatedGitTarget(this.host, worktreeSelector)
    return requireRuntimeGitProvider(target).checkIgnoredPaths(target.worktree.path, relativePaths)
  }

  async getRuntimeGitRefs(worktreeSelector: string, query?: string) {
    const target = await resolveGatedGitTarget(this.host, worktreeSelector)
    return requireRuntimeGitProvider(target).getHistoryRefs(target.worktree.path, query)
  }

  async getRuntimeGitHistory(
    worktreeSelector: string,
    options: GitHistoryOptions = {}
  ): Promise<GitHistoryResult> {
    const target = await resolveGatedGitTarget(this.host, worktreeSelector)
    return requireRuntimeGitProvider(target).getHistory(target.worktree.path, options)
  }

  async getRuntimeGitConflictOperation(worktreeSelector: string): Promise<GitConflictOperation> {
    const target = await resolveGatedGitTarget(this.host, worktreeSelector)
    return requireRuntimeGitProvider(target).detectConflictOperation(target.worktree.path)
  }

  async getRuntimeGitMutationInFlight(worktreeSelector: string): Promise<GitMutationInFlight> {
    const target = await resolveGatedGitTarget(this.host, worktreeSelector)
    requireLocalRuntimeGitRoute(target)
    return {
      inFlight: await isGitWorktreeMutationInFlight(
        target.worktree.path,
        localGitOptionsForTarget(target)
      )
    }
  }

  async readRuntimeWorktreeAtRiskLocalFiles(
    worktreeSelector: string,
    signal?: AbortSignal
  ): Promise<WorktreeAtRiskLocalFiles> {
    const target = await resolveGatedGitTarget(this.host, worktreeSelector)
    requireLocalRuntimeGitRoute(target)
    return readWorktreeAtRiskLocalFiles({
      worktreePath: target.worktree.path,
      mainCheckoutPath: target.repo?.path ?? null,
      gitOptions: { ...localGitOptionsForTarget(target), ...(signal ? { signal } : {}) }
    })
  }

  async checkoutRuntimeGitBranch(
    worktreeSelector: string,
    branch: string,
    detached = false
  ): Promise<RuntimeGitCheckoutResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    const worktreePath = target.worktree.path
    const checkoutTarget = detached ? branch.toLowerCase() : branch
    const result = await switchBranchGuarded(
      worktreePath,
      detached ? { commitId: checkoutTarget } : checkoutTarget,
      localGitOptionsForTarget(target),
      {
        getStatus: () =>
          provider.getStatus(worktreePath, {
            admissionTier: 'interactive',
            includeLineStats: false
          }),
        checkout: () => provider.checkoutBranch(worktreePath, checkoutTarget, undefined, detached),
        getAgentBlocker: async () => this.host.getAgentSwitchBlocker?.(worktreePath) ?? null,
        onSwitched: () => this.host.recordBranchSwitched?.(target.worktree, detached)
      }
    )
    return { ok: true, branch: result.branch }
  }

  async switchRuntimeGitBranch(
    worktreeSelector: string,
    branchTarget: BranchSwitchTarget
  ): Promise<RuntimeGitSwitchResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    const path = target.worktree.path
    try {
      const result = await switchBranchGuarded(
        path,
        branchTarget,
        localGitOptionsForTarget(target),
        {
          getStatus: () =>
            provider.getStatus(path, { admissionTier: 'interactive', includeLineStats: false }),
          checkout: (branch, creation) =>
            creation
              ? provider.checkoutBranch(path, branch, creation)
              : provider.checkoutBranch(path, branch),
          getAgentBlocker: async () => this.host.getAgentSwitchBlocker?.(path) ?? null,
          onSwitched: () => this.host.recordBranchSwitched?.(target.worktree)
        }
      )
      return { ok: true, branch: result.branch, head: result.head }
    } catch (error) {
      if (error instanceof BranchSwitchLandedWithWarningError) {
        return { ok: true, branch: error.branch, head: error.head, warning: error.message }
      }
      throw error
    }
  }

  async listRuntimeGitLocalBranches(worktreeSelector: string): Promise<RuntimeGitLocalBranches> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).listLocalBranches(target.worktree.path)
  }
}
