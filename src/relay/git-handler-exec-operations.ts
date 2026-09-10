import type { RequestContext } from './dispatcher'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { validateGitExecArgs } from './git-handler-ops'
import { gitExecMutatesRepository } from '../shared/git-exec-mutation'
import { normalizeGitErrorMessage } from '../shared/git-remote-error'
import { forceDeletePreservedRelayBranch } from './git-handler-branch-cleanup'

export class GitHandlerExecOperations extends GitHandlerOperationContext {
  async exec(params: Record<string, unknown>, context?: RequestContext) {
    const args = params.args as string[]
    const cwd = params.cwd as string

    validateGitExecArgs(args)
    const run = () => this.git(args, cwd, { signal: context?.signal })
    const { stdout, stderr } = gitExecMutatesRepository(args)
      ? await this.runWithGitReadCacheClear(run)
      : await run()
    return this.maybeStreamResponse({ stdout, stderr }, params, context)
  }

  async clone(params: Record<string, unknown>, context?: RequestContext) {
    const args = params.args as string[]
    const cwd = params.cwd as string
    const progressId = params.progressId
    validateGitExecArgs(args)
    if (typeof progressId !== 'string' || progressId.length === 0) {
      throw new Error('Missing clone progress id.')
    }
    if (args[0] !== 'clone') {
      throw new Error('git.clone only supports clone commands.')
    }
    return await this.runWithGitReadCacheClear(() =>
      this.spawnClone(args, cwd, progressId, context)
    )
  }

  // Why: generic git.exec blocks all `git config` writes outright (CONFIG_READ_ONLY_FLAGS),
  // so a deferred fork remote's provenance marker (#17828) needs its own narrow RPC that
  // only ever writes this fixed key shape, mirroring renameCurrentBranch below.
  async markRemoteOrcaCreated(params: Record<string, unknown>) {
    const repoPath = params.repoPath
    const remoteName = params.remoteName
    if (typeof repoPath !== 'string' || typeof remoteName !== 'string' || !remoteName) {
      throw new Error('Invalid remote provenance marker request.')
    }
    if (!/^[A-Za-z0-9._-]+$/.test(remoteName)) {
      throw new Error('Invalid remote name for provenance marker.')
    }
    await this.git(['config', `remote.${remoteName}.orca-created`, 'true'], repoPath)
  }

  async renameCurrentBranch(params: Record<string, unknown>) {
    return this.runWithGitReadCacheClear(async () => {
      const worktreePath = params.worktreePath
      const newBranch = params.newBranch
      if (typeof worktreePath !== 'string' || typeof newBranch !== 'string') {
        throw new Error('Invalid branch rename request.')
      }
      if (newBranch.startsWith('-')) {
        throw new Error('Branch name must not start with "-".')
      }
      try {
        // Why: generic git.exec blocks destructive branch flags; this narrow RPC permits only the already-checked current-branch rename.
        await this.git(['check-ref-format', '--branch', newBranch], worktreePath)
        await this.git(['branch', '-m', newBranch], worktreePath)
      } catch (error) {
        throw new Error(normalizeGitErrorMessage(error))
      }
    })
  }

  async forceDeletePreservedBranch(params: Record<string, unknown>) {
    const repoPath = params.repoPath
    const branchName = params.branchName
    const expectedHead = params.expectedHead
    if (
      typeof repoPath !== 'string' ||
      typeof branchName !== 'string' ||
      typeof expectedHead !== 'string'
    ) {
      throw new Error('Invalid preserved branch force-delete request.')
    }
    // Why: empty repoPath would target the relay's own cwd with a destructive update-ref, and NUL bytes can't reach git safely — reject both.
    if (!repoPath || repoPath.includes('\0') || expectedHead.includes('\0')) {
      throw new Error('Invalid preserved branch force-delete request.')
    }
    return this.runWithGitReadCacheClear(() =>
      forceDeletePreservedRelayBranch(this.git.bind(this), repoPath, branchName, expectedHead)
    )
  }
}
