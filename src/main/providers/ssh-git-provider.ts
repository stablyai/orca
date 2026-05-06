/* eslint-disable max-lines -- Why: this provider mirrors IGitProvider one
   method per RPC call (~16 methods). Splitting it would only add
   indirection — every method is a 1:1 forwarder to a relay RPC plus a
   small amount of param plumbing. */
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type {
  GenerateCommitMessageRequest,
  GenerateCommitMessageResponse,
  IGitProvider
} from './types'
import hostedGitInfo from 'hosted-git-info'
import type {
  GitStatusResult,
  GitDiffResult,
  GitBranchCompareResult,
  GitConflictOperation,
  GitWorktreeInfo
} from '../../shared/types'
import {
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId
} from '../../shared/commit-message-agent-spec'
import {
  buildCommitPrompt,
  cleanGeneratedCommitMessage,
  extractAgentErrorMessage,
  planCustomCommand,
  truncateDiffForPrompt
} from '../../shared/commit-message-prompt'
import { applyOrcaAttribution } from '../git/commit-message-generator'

const SSH_GENERATION_TIMEOUT_MS = 60_000

type RemoteExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  canceled?: boolean
  spawnError?: string
}

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

  async getStatus(worktreePath: string): Promise<GitStatusResult> {
    return (await this.mux.request('git.status', { worktreePath })) as GitStatusResult
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

  async generateCommitMessage(
    request: GenerateCommitMessageRequest
  ): Promise<GenerateCommitMessageResponse> {
    let diff: string
    try {
      const diffResult = await this.exec(['diff', '--cached', '--no-color'], request.worktreePath)
      diff = diffResult.stdout
    } catch (error) {
      return {
        success: false,
        error: `Failed to read staged diff: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (!diff.trim()) {
      return { success: false, error: 'No staged changes to summarize.' }
    }

    const prompt = buildCommitPrompt(truncateDiffForPrompt(diff), request.customPrompt ?? '')

    let binary: string
    let args: string[]
    let stdinPayload: string | null
    let label: string
    if (isCustomAgentId(request.agentId)) {
      const command = request.customAgentCommand?.trim() ?? ''
      if (!command) {
        return {
          success: false,
          error: 'Custom command is empty. Add one in Settings → Git → AI Commit Messages.'
        }
      }
      const planned = planCustomCommand(command, prompt)
      if (!planned.ok) {
        return { success: false, error: planned.error }
      }
      binary = planned.binary
      args = planned.args
      stdinPayload = planned.stdinPayload
      label = planned.binary
    } else {
      const spec = getCommitMessageAgentSpec(request.agentId)
      if (!spec) {
        return {
          success: false,
          error: `Agent "${request.agentId}" does not support AI commit messages.`
        }
      }
      const model = getCommitMessageModel(request.agentId, request.model)
      if (!model) {
        return {
          success: false,
          error: `Model "${request.model}" is not available for ${spec.label}.`
        }
      }
      if (request.thinkingLevel) {
        if (!model.thinkingLevels) {
          return {
            success: false,
            error: `Model "${model.label}" does not support a thinking effort level.`
          }
        }
        if (!model.thinkingLevels.some((l) => l.id === request.thinkingLevel)) {
          return {
            success: false,
            error: `Thinking level "${request.thinkingLevel}" is not valid for ${model.label}.`
          }
        }
      }
      const argvPrompt = spec.promptDelivery === 'argv' ? prompt : ''
      args = spec.buildArgs({
        prompt: argvPrompt,
        model: request.model,
        thinkingLevel: request.thinkingLevel
      })
      stdinPayload = spec.promptDelivery === 'stdin' ? prompt : null
      binary = spec.binary
      label = spec.label
    }

    const result = (await this.mux.request('agent.execNonInteractive', {
      binary,
      args,
      cwd: request.worktreePath,
      stdin: stdinPayload,
      timeoutMs: SSH_GENERATION_TIMEOUT_MS
    })) as RemoteExecResult

    if (result.spawnError) {
      // Why: ENOENT on the remote PATH is the most common failure here, so
      // surface a concrete install hint rather than the bare "ENOENT" line.
      if (/ENOENT/i.test(result.spawnError)) {
        return {
          success: false,
          error: `${binary} not found on the remote PATH. Install ${label} on the SSH host.`
        }
      }
      return { success: false, error: result.spawnError }
    }
    if (result.canceled) {
      return { success: false, error: 'Generation canceled.', canceled: true }
    }
    if (result.timedOut) {
      return {
        success: false,
        error: `Generation timed out after ${SSH_GENERATION_TIMEOUT_MS / 1000}s.`
      }
    }
    if (result.exitCode !== 0) {
      const extracted = extractAgentErrorMessage(result.stdout, result.stderr)
      const detail =
        extracted ?? result.stderr.trim() ?? result.stdout.trim() ?? `exit code ${result.exitCode}`
      return { success: false, error: `${label} failed: ${detail}` }
    }
    const cleaned = cleanGeneratedCommitMessage(result.stdout)
    if (!cleaned) {
      return { success: false, error: `${label} returned an empty message.` }
    }
    return {
      success: true,
      message: applyOrcaAttribution(cleaned, request.attributionEnabled === true)
    }
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

  async listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
    return (await this.mux.request('git.listWorktrees', {
      repoPath
    })) as GitWorktreeInfo[]
  }

  async addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; track?: boolean }
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
