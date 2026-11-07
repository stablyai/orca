import type {
  GitHistoryOptions,
  GitHistoryResult
} from '../../../../shared/git/history/git-history-types'
import type { GitMutationInFlight } from '../../../../shared/git/commands/git-mutation-in-flight'
import { isGitWorktreeMutationInFlight } from '../../../git/command-runner/git-worktree-mutation-state'
import { switchBranchGuarded } from '../../../git/branch-switch'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult
} from '../../../../shared/git/status/git-status-types'
import type {
  RuntimeGitCheckoutResult,
  RuntimeGitLocalBranches
} from '../../../../shared/runtime-worktree-contracts'
import type { GitProviderStatusOptions } from '../../../providers/git-provider-status-options'
import {
  localGitOptionsForTarget,
  requireLocalRuntimeGitRoute,
  requireRuntimeGitProvider,
  type RuntimeGitCommandHost,
  type RuntimeGitTarget
} from './runtime-git-command-target'
import { assertRuntimeReadWslDistroRunning } from './runtime-wsl-background-read-gate'

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

  async checkoutRuntimeGitBranch(
    worktreeSelector: string,
    branch: string
  ): Promise<RuntimeGitCheckoutResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    const worktreePath = target.worktree.path
    const result = await switchBranchGuarded(
      worktreePath,
      branch,
      localGitOptionsForTarget(target),
      {
        getStatus: () =>
          provider.getStatus(worktreePath, {
            admissionTier: 'interactive',
            includeLineStats: false
          }),
        checkout: () => provider.checkoutBranch(worktreePath, branch),
        getAgentBlocker: async () => this.host.getAgentSwitchBlocker?.(worktreePath) ?? null,
        onSwitched: () => this.host.recordBranchSwitched?.(target.worktree)
      }
    )
    return { ok: true, branch: result.branch }
  }

  async listRuntimeGitLocalBranches(worktreeSelector: string): Promise<RuntimeGitLocalBranches> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).listLocalBranches(target.worktree.path)
  }
}
