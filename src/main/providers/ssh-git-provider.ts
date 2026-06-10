/* eslint-disable max-lines -- Why: this provider mirrors IGitProvider one
   method per RPC call (~16 methods). Splitting it would only add
   indirection — every method is a 1:1 forwarder to a relay RPC plus a
   small amount of param plumbing. */
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IGitProvider } from './types'
import type {
  GitStatusResult,
  GitDiffResult,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitPushTarget,
  GitUpstreamStatus,
  GitWorktreeInfo,
  RemoveWorktreeResult
} from '../../shared/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import { buildHostedRemoteFileUrl } from '../git/hosted-remote-url'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import type { RemoteCommitMessageExecResult } from '../text-generation/commit-message-text-generation'
import {
  describeMaxBufferOverflowError,
  isMaxBufferOverflowError
} from '../git/max-buffer-overflow'

type NonInteractiveExecQueueEntry = {
  started: boolean
  canceled: boolean
  done: Promise<void>
  release: () => void
}

function isJsonRpcMethodNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  return (error as { code?: unknown }).code === JsonRpcErrorCode.MethodNotFound
}

function formatStatusEntriesForCleanCheck(entries: GitStatusResult['entries']): string | undefined {
  if (entries.length === 0) {
    return undefined
  }
  return entries.map((entry) => `${entry.area} ${entry.status}: ${entry.path}`).join('\n')
}

function filterUntrackedPorcelainStatus(stdout: string | undefined): string | undefined {
  const trackedLines = (stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith('?? '))
  return trackedLines.length > 0 ? trackedLines.join('\n') : undefined
}

export class SshGitProvider implements IGitProvider {
  private connectionId: string
  private mux: SshChannelMultiplexer
  private nonInteractiveExecQueues = new Map<string, NonInteractiveExecQueueEntry[]>()
  private loggedWorktreeIsCleanFallback = false

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

  async checkIgnoredPaths(worktreePath: string, relativePaths: string[]): Promise<string[]> {
    return (await this.mux.request('git.checkIgnored', {
      worktreePath,
      paths: relativePaths
    })) as string[]
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
    let stagedPatch = ''
    try {
      const patchResult = await this.exec(
        ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff'],
        worktreePath
      )
      stagedPatch = patchResult.stdout
    } catch (error) {
      if (!isMaxBufferOverflowError(error)) {
        throw error
      }
      // Why: a very large staged diff can overflow the remote exec buffer. The
      // patch is optional context (truncated later anyway), so degrade to the
      // file-name summary instead of failing commit-message generation.
      console.warn(
        '[ssh-git] Staged patch too large to read; using file summary only:',
        describeMaxBufferOverflowError(error)
      )
    }
    return {
      branch: branchResult.stdout.trim() || null,
      stagedSummary,
      stagedPatch
    }
  }

  async executeCommitMessagePlan(
    plan: CommitMessagePlan,
    cwd: string,
    timeoutMs: number,
    operation = 'commit-message'
  ): Promise<RemoteCommitMessageExecResult> {
    return this.runQueuedNonInteractiveExec(
      cwd,
      {
        binary: plan.binary,
        args: plan.args,
        cwd,
        stdin: plan.stdinPayload,
        timeoutMs,
        operation
      },
      undefined,
      operation
    )
  }

  async execNonInteractive(
    binary: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
    env?: Record<string, string>
  ): Promise<RemoteCommitMessageExecResult> {
    return this.runQueuedNonInteractiveExec(
      cwd,
      {
        binary,
        args,
        cwd,
        stdin: null,
        timeoutMs,
        ...(env ? { env } : {})
      },
      signal
    )
  }

  async cancelNonInteractiveExec(cwd: string, operation?: string): Promise<void> {
    const queue = this.nonInteractiveExecQueues.get(this.nonInteractiveLaneKey(cwd, operation))
    const queuedEntry = queue?.find((entry) => !entry.started && !entry.canceled)
    if (queuedEntry) {
      queuedEntry.canceled = true
      return
    }
    await this.cancelActiveNonInteractiveExec(cwd, operation)
  }

  private async cancelActiveNonInteractiveExec(cwd: string, operation?: string): Promise<void> {
    try {
      await this.mux.request('agent.cancelExec', {
        cwd,
        ...(operation ? { operation } : {})
      })
    } catch {
      // Best-effort: callers are already unwinding after cancellation.
    }
  }

  async cancelGenerateCommitMessage(
    worktreePath: string,
    operation = 'commit-message'
  ): Promise<void> {
    // Why: best-effort — the relay returns `{canceled: false}` when there is
    // nothing in flight. Callers should not block UI updates on this.
    await this.cancelNonInteractiveExec(worktreePath, operation)
  }

  private nonInteractiveLaneKey(cwd: string, operation?: string): string {
    return JSON.stringify([operation || 'default', cwd])
  }

  private async runQueuedNonInteractiveExec(
    cwd: string,
    payload: {
      binary: string
      args: string[]
      cwd: string
      stdin: string | null
      timeoutMs: number
      env?: Record<string, string>
      operation?: string
    },
    signal?: AbortSignal,
    operation?: string
  ): Promise<RemoteCommitMessageExecResult> {
    const laneKey = this.nonInteractiveLaneKey(cwd, operation)
    const queue = this.nonInteractiveExecQueues.get(laneKey) ?? []
    const previous = queue.at(-1)?.done ?? Promise.resolve()
    let releaseEntry!: () => void
    const entry: NonInteractiveExecQueueEntry = {
      started: false,
      canceled: false,
      done: previous
        .catch(() => {})
        .then(
          () =>
            new Promise<void>((resolve) => {
              releaseEntry = resolve
            })
        ),
      release: () => releaseEntry()
    }
    queue.push(entry)
    this.nonInteractiveExecQueues.set(laneKey, queue)
    const abortEntry = (): void => {
      if (!entry.started) {
        entry.canceled = true
        return
      }
      void this.cancelActiveNonInteractiveExec(cwd, operation)
    }
    if (signal?.aborted) {
      entry.canceled = true
    } else {
      signal?.addEventListener('abort', abortEntry, { once: true })
    }

    // Why: the SSH relay tracks children per operation; serialize only matching
    // lanes so commit-message and PR-field generation can coexist.
    await previous.catch(() => {})
    try {
      if (entry.canceled) {
        return {
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          canceled: true
        }
      }
      entry.started = true
      return (await this.mux.request(
        'agent.execNonInteractive',
        payload
      )) as RemoteCommitMessageExecResult
    } finally {
      signal?.removeEventListener('abort', abortEntry)
      entry.release()
      const currentQueue = this.nonInteractiveExecQueues.get(laneKey)
      const entryIndex = currentQueue?.indexOf(entry) ?? -1
      if (entryIndex >= 0) {
        currentQueue?.splice(entryIndex, 1)
      }
      if (currentQueue?.length === 0) {
        this.nonInteractiveExecQueues.delete(laneKey)
      }
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

  async abortMerge(worktreePath: string): Promise<void> {
    await this.mux.request('git.abortMerge', { worktreePath })
  }

  async abortRebase(worktreePath: string): Promise<void> {
    await this.mux.request('git.abortRebase', { worktreePath })
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

  async getUpstreamStatus(
    worktreePath: string,
    pushTarget?: GitPushTarget
  ): Promise<GitUpstreamStatus> {
    return (await this.mux.request('git.upstreamStatus', {
      worktreePath,
      ...(pushTarget ? { pushTarget } : {})
    })) as GitUpstreamStatus
  }

  async pushBranch(
    worktreePath: string,
    publish = false,
    pushTarget?: GitPushTarget,
    options: { forceWithLease?: boolean } = {}
  ): Promise<void> {
    await this.mux.request('git.push', {
      worktreePath,
      publish,
      pushTarget,
      ...(options.forceWithLease === true ? { forceWithLease: true } : {})
    })
  }

  async pullBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    await this.mux.request('git.pull', { worktreePath, ...(pushTarget ? { pushTarget } : {}) })
  }

  async fastForwardBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    await this.mux.request('git.fastForward', {
      worktreePath,
      ...(pushTarget ? { pushTarget } : {})
    })
  }

  async rebaseFromBase(worktreePath: string, baseRef: string): Promise<void> {
    await this.mux.request('git.rebaseFromBase', { worktreePath, baseRef })
  }

  async fetchRemote(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    await this.mux.request('git.fetch', { worktreePath, ...(pushTarget ? { pushTarget } : {}) })
  }

  async fetchRemoteTrackingRef(
    worktreePath: string,
    remote: string,
    branch: string,
    ref: string
  ): Promise<void> {
    await this.mux.request('git.fetchRemoteTrackingRef', {
      worktreePath,
      remote,
      branch,
      ref
    })
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
    options?: { base?: string; checkoutExistingBranch?: boolean; noCheckout?: boolean }
  ): Promise<void> {
    await this.mux.request('git.addWorktree', {
      repoPath,
      branchName,
      targetDir,
      ...options
    })
  }

  async removeWorktree(
    worktreePath: string,
    force?: boolean,
    options?: { deleteBranch?: boolean; forceBranchDelete?: boolean }
  ): Promise<RemoveWorktreeResult> {
    return ((await this.mux.request('git.removeWorktree', {
      worktreePath,
      force,
      ...options
    })) ?? {}) as RemoveWorktreeResult
  }

  async worktreeIsClean(
    worktreePath: string,
    options: { includeUntracked?: boolean } = {}
  ): Promise<{ clean: boolean; stdout?: string }> {
    try {
      const result = (await this.mux.request('git.worktreeIsClean', {
        worktreePath,
        ...(options.includeUntracked === false ? { includeUntracked: false } : {})
      })) as {
        clean: boolean
        stdout?: string
      }
      if (options.includeUntracked === false) {
        if (!result.clean && result.stdout === undefined) {
          return result
        }
        const trackedStdout = filterUntrackedPorcelainStatus(result.stdout)
        return { clean: !trackedStdout, ...(trackedStdout ? { stdout: trackedStdout } : {}) }
      }
      return result
    } catch (error) {
      if (!isJsonRpcMethodNotFoundError(error)) {
        throw error
      }
      if (!this.loggedWorktreeIsCleanFallback) {
        this.loggedWorktreeIsCleanFallback = true
        console.warn(
          '[ssh-git] Relay does not implement git.worktreeIsClean; falling back to git.status clean check'
        )
      }
      // Why: existing SSH relays may predate git.worktreeIsClean, but git.status
      // is a narrow relay RPC and avoids the generic git.exec allowlist.
      const status = await this.getStatus(worktreePath)
      const entries =
        options.includeUntracked === false
          ? status.entries.filter((entry) => entry.area !== 'untracked')
          : status.entries
      const clean = entries.length === 0
      return { clean, stdout: formatStatusEntriesForCleanCheck(entries) }
    }
  }

  async refreshLocalBaseRefForWorktreeCreate(args: {
    repoPath: string
    fullRef: string
    remoteTrackingRef: string
    ownerWorktreePath?: string
    checkOnly?: boolean
  }): Promise<void> {
    await this.mux.request('git.refreshLocalBaseRefForWorktreeCreate', args)
  }

  async renameCurrentBranch(worktreePath: string, newBranch: string): Promise<void> {
    await this.mux.request('git.renameCurrentBranch', { worktreePath, newBranch })
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

  // Why: SSH worktrees need the remote URL from the relay-side .git/config
  // before local code can map it to a hosted source link.
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

    return buildHostedRemoteFileUrl(remoteUrl, relativePath, defaultBranch, line)
  }
}
