/* eslint-disable max-lines -- Why: this provider mirrors IGitProvider one
   method per RPC call (~16 methods). Splitting it would only add
   indirection — every method is a 1:1 forwarder to a relay RPC plus a
   small amount of param plumbing. */
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IGitProvider } from './types'
import hostedGitInfo from 'hosted-git-info'
import type {
  GitStatusResult,
  GitDiffResult,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitPushTarget,
  GitUpstreamStatus,
  GitWorktreeInfo
} from '../../shared/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import type { RemoteCommitMessageExecResult } from '../text-generation/commit-message-text-generation'

export class SshGitProvider implements IGitProvider {
  private connectionId: string
  private mux: SshChannelMultiplexer

  constructor(connectionId: string, mux: SshChannelMultiplexer) {
    this.connectionId = connectionId
    this.mux = mux
  }

  getConnectionId(): string {
    return this.connectionId
  }

  async getStatus(
    worktreePath: string,
    options?: { includeIgnored?: boolean }
  ): Promise<GitStatusResult> {
    const includeIgnoredArgs = options?.includeIgnored ? { includeIgnored: true } : {}
    return (await this.mux.request('git.status', {
      worktreePath,
      ...includeIgnoredArgs
    })) as GitStatusResult
  }

  async getHistory(
    worktreePath: string,
    options: GitHistoryOptions = {}
  ): Promise<GitHistoryResult> {
    return (await this.mux.request('git.history', {
      worktreePath,
      ...options
    })) as GitHistoryResult
  }

  async commit(
    worktreePath: string,
    message: string
  ): Promise<{ success: boolean; error?: string }> {
    return (await this.mux.request('git.commit', {
      worktreePath,
      message
    })) as { success: boolean; error?: string }
  }

  async getStagedCommitContext(worktreePath: string): Promise<CommitMessageDraftContext | null> {
    const branchPromise = this.exec(['branch', '--show-current'], worktreePath).catch(() => ({
      stdout: ''
    }))
    const [branchResult, summaryResult] = await Promise.all([
      branchPromise,
      this.exec(['diff', '--cached', '--name-status'], worktreePath)
    ])
    const stagedSummary = summaryResult.stdout.trim()
    if (!stagedSummary) {
      return null
    }
    const { stdout: stagedPatch } = await this.exec(
      ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff'],
      worktreePath
    )
    return {
      branch: branchResult.stdout.trim() || null,
      stagedSummary,
      stagedPatch
    }
  }

  async executeCommitMessagePlan(
    plan: CommitMessagePlan,
    cwd: string,
    timeoutMs: number
  ): Promise<RemoteCommitMessageExecResult> {
    return (await this.mux.request('agent.execNonInteractive', {
      binary: plan.binary,
      args: plan.args,
      cwd,
      stdin: plan.stdinPayload,
      timeoutMs
    })) as RemoteCommitMessageExecResult
  }

  async cancelGenerateCommitMessage(worktreePath: string): Promise<void> {
    // Why: best-effort — the relay returns `{canceled: false}` when there is
    // nothing in flight. Callers should not block UI updates on this.
    try {
      await this.mux.request('agent.cancelExec', { cwd: worktreePath })
    } catch {
      // Swallow: cancellation is a fire-and-forget user intent. The pending
      // generateCommitMessage promise will still resolve with the kill result.
    }
  }

  async getDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    compareAgainstHead?: boolean
  ): Promise<GitDiffResult> {
    return (await this.mux.request('git.diff', {
      worktreePath,
      filePath,
      staged,
      compareAgainstHead
    })) as GitDiffResult
  }

  async stageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.mux.request('git.stage', { worktreePath, filePath })
  }

  async unstageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.mux.request('git.unstage', { worktreePath, filePath })
  }

  async bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.mux.request('git.bulkStage', { worktreePath, filePaths })
  }

  async bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.mux.request('git.bulkUnstage', { worktreePath, filePaths })
  }

  async discardChanges(worktreePath: string, filePath: string): Promise<void> {
    await this.mux.request('git.discard', { worktreePath, filePath })
  }

  async bulkDiscardChanges(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.mux.request('git.bulkDiscard', { worktreePath, filePaths })
  }

  async detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
    return (await this.mux.request('git.conflictOperation', {
      worktreePath
    })) as GitConflictOperation
  }

  async getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult> {
    return (await this.mux.request('git.branchCompare', {
      worktreePath,
      baseRef
    })) as GitBranchCompareResult
  }

  async getCommitCompare(worktreePath: string, commitId: string): Promise<GitCommitCompareResult> {
    return (await this.mux.request('git.commitCompare', {
      worktreePath,
      commitId
    })) as GitCommitCompareResult
  }

  async getUpstreamStatus(worktreePath: string): Promise<GitUpstreamStatus> {
    return (await this.mux.request('git.upstreamStatus', {
      worktreePath
    })) as GitUpstreamStatus
  }

  async pushBranch(
    worktreePath: string,
    publish = false,
    pushTarget?: GitPushTarget
  ): Promise<void> {
    await this.mux.request('git.push', { worktreePath, publish, pushTarget })
  }

  async pullBranch(worktreePath: string): Promise<void> {
    await this.mux.request('git.pull', { worktreePath })
  }

  async fetchRemote(worktreePath: string): Promise<void> {
    await this.mux.request('git.fetch', { worktreePath })
  }

  async getBranchDiff(
    worktreePath: string,
    baseRef: string,
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string }
  ): Promise<GitDiffResult[]> {
    return (await this.mux.request('git.branchDiff', {
      worktreePath,
      baseRef,
      ...options
    })) as GitDiffResult[]
  }

  async getCommitDiff(
    worktreePath: string,
    args: { commitOid: string; parentOid?: string | null; filePath: string; oldPath?: string }
  ): Promise<GitDiffResult> {
    return (await this.mux.request('git.commitDiff', {
      worktreePath,
      ...args
    })) as GitDiffResult
  }

  async listWorktrees(
    repoPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<GitWorktreeInfo[]> {
    return (await this.mux.request(
      'git.listWorktrees',
      {
        repoPath
      },
      { signal: options?.signal }
    )) as GitWorktreeInfo[]
  }

  async addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string }
  ): Promise<void> {
    await this.mux.request('git.addWorktree', {
      repoPath,
      branchName,
      targetDir,
      ...options
    })
  }

  async removeWorktree(worktreePath: string, force?: boolean): Promise<void> {
    await this.mux.request('git.removeWorktree', { worktreePath, force })
  }

  async exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return (await this.mux.request('git.exec', { args, cwd })) as {
      stdout: string
      stderr: string
    }
  }

  async isGitRepoAsync(dirPath: string): Promise<{ isRepo: boolean; rootPath: string | null }> {
    return (await this.mux.request('git.isGitRepo', { dirPath })) as {
      isRepo: boolean
      rootPath: string | null
    }
  }

  // Why: isGitRepo requires synchronous return in the interface, but remote
  // operations are async. We always return true for remote paths since the
  // relay validates git repos on its side. The renderer already guards git
  // operations behind worktree registration which validates the path.
  isGitRepo(_path: string): boolean {
    return true
  }

  // Why: the local getRemoteFileUrl uses hosted-git-info which requires the
  // remote URL from .git/config. For SSH connections we must fetch the remote
  // URL from the relay, then apply the same hosted-git-info logic locally.
  async getRemoteFileUrl(
    worktreePath: string,
    relativePath: string,
    line: number
  ): Promise<string | null> {
    let remoteUrl: string
    try {
      const result = await this.exec(['remote', 'get-url', 'origin'], worktreePath)
      remoteUrl = result.stdout.trim()
    } catch {
      return null
    }
    if (!remoteUrl) {
      return null
    }

    const info = hostedGitInfo.fromUrl(remoteUrl)
    if (!info) {
      return null
    }

    let defaultBranch = 'main'
    try {
      const refResult = await this.exec(
        ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
        worktreePath
      )
      const ref = refResult.stdout.trim()
      if (ref) {
        defaultBranch = ref.replace(/^refs\/remotes\/origin\//, '')
      }
    } catch {
      // Fall back to 'main'
    }

    const browseUrl = info.browseFile(relativePath, { committish: defaultBranch })
    if (!browseUrl) {
      return null
    }

    // Why: hosted-git-info lowercases the fragment, but GitHub convention
    // uses uppercase L for line links (e.g. #L42). Append manually.
    return `${browseUrl}#L${line}`
  }
}
