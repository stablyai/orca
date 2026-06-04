/* eslint-disable max-lines */
import type { DockerEngineClientLike } from '../docker/docker-engine-client'
import { DockerEngineClient } from '../docker/docker-engine-client'
import {
  resolveDockerContainerPath,
  resolveDockerContainerRelativePath
} from '../docker/docker-container-path'
import type { DockerTarget } from '../docker/types'
import { buildHostedRemoteFileUrl } from '../git/hosted-remote-url'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import type { IGitProvider } from './types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitBranchChangeStatus,
  GitConflictKind,
  GitConflictOperation,
  GitDiffResult,
  GitFileStatus,
  GitPushTarget,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus,
  GitWorktreeInfo,
  RemoveWorktreeResult
} from '../../shared/types'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import { loadGitHistoryFromExecutor } from '../../shared/git-history'
import { isBinaryBuffer } from '../../shared/binary-buffer'
import {
  getEffectiveGitUpstreamStatus,
  resolveEffectiveGitUpstream
} from '../../shared/git-effective-upstream'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'
import { resolveGitRemoteRebaseSource } from '../../shared/git-rebase-source'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../../shared/git-remote-error'

const MAX_DOCKER_GIT_BLOB_BYTES = 10 * 1024 * 1024
const BULK_CHUNK_SIZE = 100

export class DockerGitProvider implements IGitProvider {
  private target: DockerTarget
  private engine: DockerEngineClientLike

  constructor(target: DockerTarget, engine: DockerEngineClientLike = new DockerEngineClient()) {
    this.target = target
    this.engine = engine
  }

  getConnectionId(): string {
    return this.target.containerId
  }

  async getStatus(
    worktreePath: string,
    options: { includeIgnored?: boolean } = {}
  ): Promise<GitStatusResult> {
    const statusArgs = [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all'
    ]
    if (options.includeIgnored) {
      statusArgs.push('--ignored=matching')
    }
    const [status, conflictOperation] = await Promise.all([
      this.git(statusArgs, worktreePath),
      this.detectConflictOperation(worktreePath)
    ])
    return parseStatus(status.stdout, conflictOperation, options.includeIgnored === true)
  }

  async checkIgnoredPaths(worktreePath: string, relativePaths: string[]): Promise<string[]> {
    const ignored = new Set<string>()
    const safePaths = relativePaths.map((relativePath) => this.relativePath(relativePath))
    for (let i = 0; i < safePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = safePaths.slice(i, i + BULK_CHUNK_SIZE)
      try {
        const { stdout } = await this.git(
          ['-c', 'core.quotePath=false', 'check-ignore', '--', ...chunk],
          worktreePath
        )
        for (const ignoredPath of stdout.split(/\r?\n/).filter(Boolean)) {
          ignored.add(ignoredPath)
        }
      } catch (error) {
        if (!isExitCode(error, 1)) {
          throw error
        }
      }
    }
    return Array.from(ignored)
  }

  async getHistory(
    worktreePath: string,
    options: GitHistoryOptions = {}
  ): Promise<GitHistoryResult> {
    return loadGitHistoryFromExecutor(
      (args, cwd) => this.git(args, cwd),
      this.worktreePath(worktreePath),
      options
    )
  }

  async commit(
    worktreePath: string,
    message: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.git(['commit', '-m', message], worktreePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: getGitErrorMessage(error) }
    }
  }

  async getStagedCommitContext(worktreePath: string): Promise<CommitMessageDraftContext | null> {
    const branchPromise = this.git(['branch', '--show-current'], worktreePath).catch(() => ({
      stdout: ''
    }))
    const [branchResult, summaryResult] = await Promise.all([
      branchPromise,
      this.git(['diff', '--cached', '--name-status'], worktreePath)
    ])
    const stagedSummary = summaryResult.stdout.trim()
    if (!stagedSummary) {
      return null
    }
    const { stdout: stagedPatch } = await this.git(
      ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff'],
      worktreePath
    )
    return {
      branch: branchResult.stdout.trim() || null,
      stagedSummary,
      stagedPatch
    }
  }

  async getDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    compareAgainstHead = false
  ): Promise<GitDiffResult> {
    const safePath = this.relativePath(filePath)
    const originalBlob = staged
      ? await this.readGitBlob(worktreePath, 'HEAD', safePath)
      : compareAgainstHead
        ? await this.readGitBlob(worktreePath, 'HEAD', safePath)
        : await this.readUnstagedLeftBlob(worktreePath, safePath)
    const modifiedContent = staged
      ? await this.readGitIndexBlob(worktreePath, safePath)
      : await this.readWorkingTreeFile(worktreePath, safePath)

    return buildDiffResult(
      originalBlob.content,
      modifiedContent.content,
      originalBlob.isBinary,
      modifiedContent.isBinary,
      safePath
    )
  }

  async stageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.git(['add', '--', this.relativePath(filePath)], worktreePath)
  }

  async unstageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.git(['restore', '--staged', '--', this.relativePath(filePath)], worktreePath)
  }

  async bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.runBulkPathCommand(worktreePath, ['add'], filePaths)
  }

  async bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.runBulkPathCommand(worktreePath, ['restore', '--staged'], filePaths)
  }

  async discardChanges(worktreePath: string, filePath: string): Promise<void> {
    await this.bulkDiscardChanges(worktreePath, [filePath])
  }

  async bulkDiscardChanges(worktreePath: string, filePaths: string[]): Promise<void> {
    const safePaths = filePaths.map((filePath) => this.relativePath(filePath))
    for (let i = 0; i < safePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = safePaths.slice(i, i + BULK_CHUNK_SIZE)
      try {
        await this.git(['restore', '--worktree', '--source=HEAD', '--', ...chunk], worktreePath)
      } catch {
        // Why: untracked paths cannot be restored. Use git clean pathspecs
        // instead of raw rm so cleanup stays inside Git's worktree rules.
        await this.git(['clean', '-ffdx', '--', ...chunk], worktreePath)
      }
    }
  }

  async detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
    const gitDir = (await this.git(['rev-parse', '--git-dir'], worktreePath)).stdout.trim()
    const checks = await Promise.all([
      this.pathExists(worktreePath, `${gitDir}/MERGE_HEAD`),
      this.pathExists(worktreePath, `${gitDir}/CHERRY_PICK_HEAD`),
      this.pathExists(worktreePath, `${gitDir}/rebase-merge`),
      this.pathExists(worktreePath, `${gitDir}/rebase-apply`)
    ])
    if (checks[0]) {
      return 'merge'
    }
    if (checks[1]) {
      return 'cherry-pick'
    }
    if (checks[2] || checks[3]) {
      return 'rebase'
    }
    return 'unknown'
  }

  async abortMerge(worktreePath: string): Promise<void> {
    await this.git(['merge', '--abort'], worktreePath)
  }

  async abortRebase(worktreePath: string): Promise<void> {
    await this.git(['rebase', '--abort'], worktreePath)
  }

  async getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult> {
    const summary: GitBranchCompareResult['summary'] = {
      baseRef,
      baseOid: null as string | null,
      compareRef: 'HEAD',
      headOid: null as string | null,
      mergeBase: null as string | null,
      changedFiles: 0,
      status: 'loading' as GitBranchCompareResult['summary']['status']
    }

    try {
      summary.headOid = (
        await this.git(['rev-parse', '--verify', 'HEAD'], worktreePath)
      ).stdout.trim()
    } catch {
      summary.status = 'unborn-head'
      summary.errorMessage =
        'This branch does not have a committed HEAD yet, so compare-to-base is unavailable.'
      return { summary, entries: [] }
    }

    try {
      summary.baseOid = (
        await this.git(['rev-parse', '--verify', '--end-of-options', baseRef], worktreePath)
      ).stdout.trim()
    } catch {
      summary.status = 'invalid-base'
      summary.errorMessage = `Base ref ${baseRef} could not be resolved in this repository.`
      return { summary, entries: [] }
    }

    try {
      summary.mergeBase = (
        await this.git(['merge-base', summary.baseOid, summary.headOid], worktreePath)
      ).stdout.trim()
    } catch {
      summary.status = 'no-merge-base'
      summary.errorMessage = `This branch and ${baseRef} do not share a merge base, so compare-to-base is unavailable.`
      return { summary, entries: [] }
    }

    try {
      const [names, commitsAhead] = await Promise.all([
        this.git(
          [
            '-c',
            'core.quotePath=false',
            'diff',
            '--name-status',
            '-M',
            '-C',
            summary.mergeBase,
            summary.headOid
          ],
          worktreePath
        ),
        this.git(['rev-list', '--count', `${summary.baseOid}..${summary.headOid}`], worktreePath)
      ])
      const entries = parseBranchChanges(names.stdout)
      summary.changedFiles = entries.length
      summary.commitsAhead = Number.parseInt(commitsAhead.stdout.trim(), 10) || 0
      summary.status = 'ready'
      return { summary, entries }
    } catch (error) {
      summary.status = 'error'
      summary.errorMessage =
        error instanceof Error ? error.message : 'Failed to load branch compare'
      return { summary, entries: [] }
    }
  }

  async getCommitCompare(worktreePath: string, commitId: string): Promise<GitCommitCompareResult> {
    let commitOid = ''
    try {
      commitOid = (
        await this.git(
          ['rev-parse', '--verify', '--end-of-options', `${commitId}^{commit}`],
          worktreePath
        )
      ).stdout.trim()
    } catch {
      return {
        summary: {
          commitOid: '',
          parentOid: null,
          compareRef: commitId,
          baseRef: 'parent',
          changedFiles: 0,
          status: 'invalid-commit',
          errorMessage: `Commit ${commitId} could not be resolved in this repository.`
        },
        entries: []
      }
    }

    const summary = {
      commitOid,
      parentOid: null as string | null,
      compareRef: commitOid.slice(0, 7),
      baseRef: 'empty tree',
      changedFiles: 0,
      status: 'ready' as const
    }
    try {
      const { stdout: parents } = await this.git(
        ['rev-list', '--parents', '-n', '1', commitOid],
        worktreePath
      )
      const [, parentOid] = parents.trim().split(/\s+/)
      summary.parentOid = parentOid ?? null
      summary.baseRef = parentOid ? parentOid.slice(0, 7) : 'empty tree'
      const entries = await this.loadCommitChanges(worktreePath, summary.parentOid, commitOid)
      summary.changedFiles = entries.length
      return { summary, entries }
    } catch (error) {
      return {
        summary: {
          ...summary,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Failed to load commit diff'
        },
        entries: []
      }
    }
  }

  async getBranchDiff(
    worktreePath: string,
    baseRef: string,
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string }
  ): Promise<GitDiffResult[]> {
    const entries = options?.filePath
      ? [
          {
            path: this.relativePath(options.filePath),
            status: 'modified' as const,
            ...(options.oldPath ? { oldPath: this.relativePath(options.oldPath) } : {})
          }
        ]
      : await this.loadBranchChanges(worktreePath, baseRef)

    if (options?.includePatch === false) {
      return entries.map(() => buildTextDiffResult('', ''))
    }

    return Promise.all(
      entries.map(async (entry) => {
        const originalContent = await this.readGitBlob(
          worktreePath,
          baseRef,
          entry.oldPath ?? entry.path
        )
        const modifiedContent = await this.readGitBlob(worktreePath, 'HEAD', entry.path)
        return buildDiffResult(
          originalContent.content,
          modifiedContent.content,
          originalContent.isBinary,
          modifiedContent.isBinary,
          entry.path
        )
      })
    )
  }

  async getCommitDiff(
    worktreePath: string,
    args: { commitOid: string; parentOid?: string | null; filePath: string; oldPath?: string }
  ): Promise<GitDiffResult> {
    try {
      const safePath = this.relativePath(args.filePath)
      const safeOldPath = args.oldPath ? this.relativePath(args.oldPath) : safePath
      const originalContent = args.parentOid
        ? await this.readGitBlob(worktreePath, args.parentOid, safeOldPath)
        : { content: '', isBinary: false, exists: true }
      const modifiedContent = await this.readGitBlob(worktreePath, args.commitOid, safePath)
      return buildDiffResult(
        originalContent.content,
        modifiedContent.content,
        originalContent.isBinary,
        modifiedContent.isBinary,
        safePath
      )
    } catch {
      return buildTextDiffResult('', '')
    }
  }

  async getUpstreamStatus(
    worktreePath: string,
    pushTarget?: GitPushTarget
  ): Promise<GitUpstreamStatus> {
    try {
      if (pushTarget) {
        const target = await this.validatePushTarget(worktreePath, pushTarget)
        return getPublishTargetStatus(
          (args) => this.git(args, worktreePath),
          target,
          (upstreamName) => this.getBehindCommitsArePatchEquivalent(worktreePath, upstreamName)
        )
      }
      return await getEffectiveGitUpstreamStatus(
        (args) => this.git(args, worktreePath),
        (upstreamName) => this.getBehindCommitsArePatchEquivalent(worktreePath, upstreamName)
      )
    } catch (error) {
      if (isNoUpstreamError(error)) {
        return { hasUpstream: false, ahead: 0, behind: 0 }
      }
      throw new Error(normalizeGitErrorMessage(error, 'upstream'))
    }
  }

  async pushBranch(
    worktreePath: string,
    _publish = false,
    pushTarget?: GitPushTarget,
    options: { forceWithLease?: boolean } = {}
  ): Promise<void> {
    try {
      const target = pushTarget
        ? explicitPushTarget(await this.validatePushTarget(worktreePath, pushTarget))
        : await this.getConfiguredPushTarget(worktreePath)
      await this.git(
        [
          'push',
          ...(options.forceWithLease ? ['--force-with-lease'] : []),
          '--set-upstream',
          ...(target ? [target.remote, target.refspec] : ['origin', 'HEAD'])
        ],
        worktreePath
      )
    } catch (error) {
      throw new Error(normalizeGitErrorMessage(error, 'push'))
    }
  }

  async pullBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    try {
      if (pushTarget) {
        const target = await this.validatePushTarget(worktreePath, pushTarget)
        await this.git(['pull', target.remoteName, target.branchName], worktreePath)
        return
      }
      const upstream = await resolveEffectiveGitUpstream((args) => this.git(args, worktreePath))
      if (upstream && !upstream.isConfiguredUpstream) {
        await this.git(['pull', upstream.remoteName, upstream.branchName], worktreePath)
        return
      }
      await this.git(['pull'], worktreePath)
    } catch (error) {
      throw new Error(normalizeGitErrorMessage(error, 'pull'))
    }
  }

  async fastForwardBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    try {
      if (pushTarget) {
        const target = await this.validatePushTarget(worktreePath, pushTarget)
        await this.git(['pull', '--ff-only', target.remoteName, target.branchName], worktreePath)
        return
      }
      const upstream = await resolveEffectiveGitUpstream((args) => this.git(args, worktreePath))
      if (upstream && !upstream.isConfiguredUpstream) {
        await this.git(
          ['pull', '--ff-only', upstream.remoteName, upstream.branchName],
          worktreePath
        )
        return
      }
      await this.git(['pull', '--ff-only'], worktreePath)
    } catch (error) {
      throw new Error(normalizeGitErrorMessage(error, 'pull'))
    }
  }

  async rebaseFromBase(worktreePath: string, baseRef: string): Promise<void> {
    try {
      const source = await resolveGitRemoteRebaseSource(
        (args) => this.git(args, worktreePath),
        baseRef
      )
      await this.git(['pull', '--rebase', source.remoteName, source.branchName], worktreePath)
    } catch (error) {
      throw new Error(normalizeGitErrorMessage(error, 'pull'))
    }
  }

  async fetchRemote(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    try {
      if (pushTarget) {
        const target = await this.validatePushTarget(worktreePath, pushTarget)
        await this.git(['fetch', '--prune', target.remoteName], worktreePath)
        return
      }
      await this.git(['fetch', '--prune'], worktreePath)
    } catch (error) {
      throw new Error(normalizeGitErrorMessage(error, 'fetch'))
    }
  }

  async listWorktrees(
    repoPath: string,
    _options?: { signal?: AbortSignal }
  ): Promise<GitWorktreeInfo[]> {
    const result = await this.git(['worktree', 'list', '--porcelain'], repoPath)
    return parseWorktrees(result.stdout)
  }

  async addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; checkoutExistingBranch?: boolean; noCheckout?: boolean }
  ): Promise<void> {
    const args = ['worktree', 'add']
    const safeTargetDir = this.worktreePath(targetDir)
    if (options?.noCheckout) {
      args.push('--no-checkout')
    }
    if (options?.checkoutExistingBranch) {
      args.push(safeTargetDir, branchName)
    } else {
      args.push('--no-track', '-b', branchName, safeTargetDir)
    }
    if (options?.base && !options.checkoutExistingBranch) {
      args.push(options.base)
    }
    await this.git(args, repoPath)
  }

  async removeWorktree(
    worktreePath: string,
    force?: boolean,
    options: { deleteBranch?: boolean; forceBranchDelete?: boolean } = {}
  ): Promise<RemoveWorktreeResult> {
    const safeWorktreePath = this.worktreePath(worktreePath)
    await this.git(
      ['worktree', 'remove', ...(force ? ['--force'] : []), safeWorktreePath],
      this.target.workdir
    )
    await this.git(['worktree', 'prune'], this.target.workdir)
    // Why: container-side removal does not attempt branch cleanup, so there is
    // never a preserved-branch outcome to report.
    void options
    return {}
  }

  async exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.git(args, cwd)
  }

  async isGitRepoAsync(dirPath: string): Promise<{ isRepo: boolean; rootPath: string | null }> {
    try {
      const rootPath = (await this.git(['rev-parse', '--show-toplevel'], dirPath)).stdout.trim()
      return { isRepo: true, rootPath }
    } catch {
      return { isRepo: false, rootPath: null }
    }
  }

  isGitRepo(_path: string): boolean {
    return true
  }

  async worktreeIsClean(worktreePath: string): Promise<{ clean: boolean; stdout?: string }> {
    const result = await this.git(['status', '--porcelain'], worktreePath)
    const stdout = result.stdout.trim()
    return stdout ? { clean: false, stdout } : { clean: true }
  }

  async renameCurrentBranch(worktreePath: string, newBranch: string): Promise<void> {
    await this.git(['check-ref-format', '--branch', newBranch], worktreePath)
    await this.git(['branch', '-m', newBranch], worktreePath)
  }

  async fetchRemoteTrackingRef(
    worktreePath: string,
    remote: string,
    _branch: string,
    ref: string
  ): Promise<void> {
    await this.git(['fetch', '--prune', remote, ref], worktreePath)
  }

  async getRemoteFileUrl(
    worktreePath: string,
    relativePath: string,
    line: number
  ): Promise<string | null> {
    let remoteUrl: string
    try {
      remoteUrl = (await this.exec(['remote', 'get-url', 'origin'], worktreePath)).stdout.trim()
    } catch {
      return null
    }
    const defaultBaseRef = await resolveDefaultBaseRefViaExec((argv) =>
      this.git(argv, worktreePath)
    )
    if (!defaultBaseRef) {
      return null
    }
    const defaultBranch = defaultBaseRef.replace(/^origin\//, '')
    return buildHostedRemoteFileUrl(remoteUrl, relativePath, defaultBranch, line)
  }

  private async git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const result = await this.engine.exec({
      containerId: this.target.containerId,
      args: ['git', ...args],
      cwd: this.worktreePath(cwd)
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }

  private worktreePath(inputPath: string): string {
    return resolveDockerContainerPath(this.target, inputPath)
  }

  private relativePath(inputPath: string): string {
    return resolveDockerContainerRelativePath(this.target, inputPath)
  }

  private async pathExists(cwd: string, targetPath: string): Promise<boolean> {
    try {
      await this.engine.exec({
        containerId: this.target.containerId,
        args: ['test', '-e', targetPath],
        cwd
      })
      return true
    } catch {
      return false
    }
  }

  private async loadBranchChanges(
    worktreePath: string,
    baseRef: string
  ): Promise<GitBranchChangeEntry[]> {
    const result = await this.git(
      ['diff', '--name-status', '-M', '-C', baseRef, 'HEAD'],
      worktreePath
    )
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseBranchChangeLine)
      .filter((entry): entry is GitBranchChangeEntry => entry !== null)
  }

  private async runBulkPathCommand(
    worktreePath: string,
    baseArgs: string[],
    filePaths: string[]
  ): Promise<void> {
    const safePaths = filePaths.map((filePath) => this.relativePath(filePath))
    for (let i = 0; i < safePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = safePaths.slice(i, i + BULK_CHUNK_SIZE)
      if (chunk.length > 0) {
        await this.git([...baseArgs, '--', ...chunk], worktreePath)
      }
    }
  }

  private async loadCommitChanges(
    worktreePath: string,
    parentOid: string | null,
    commitOid: string
  ): Promise<GitBranchChangeEntry[]> {
    const args = parentOid
      ? ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', parentOid, commitOid]
      : [
          '-c',
          'core.quotePath=false',
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-status',
          '-r',
          '-M',
          '-C',
          commitOid
        ]
    const result = await this.git(args, worktreePath)
    return parseBranchChanges(result.stdout)
  }

  private async validatePushTarget(
    worktreePath: string,
    target: GitPushTarget
  ): Promise<GitPushTarget> {
    assertGitPushTargetShape(target)
    await this.git(['check-ref-format', '--branch', target.branchName], worktreePath)
    return target
  }

  private async getBehindCommitsArePatchEquivalent(
    worktreePath: string,
    upstreamName: string
  ): Promise<boolean> {
    try {
      const { stdout } = await this.git(
        ['log', '--oneline', '--cherry-mark', '--right-only', `HEAD...${upstreamName}`, '--'],
        worktreePath
      )
      return stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .every((line) => line.startsWith('='))
    } catch {
      return false
    }
  }

  private async getConfiguredPushTarget(
    worktreePath: string
  ): Promise<{ remote: string; refspec: string } | null> {
    try {
      const { stdout: branchStdout } = await this.git(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        worktreePath
      )
      const branch = branchStdout.trim()
      if (!branch) {
        return null
      }
      const [{ stdout: remoteStdout }, { stdout: mergeStdout }] = await Promise.all([
        this.git(['config', '--get', `branch.${branch}.remote`], worktreePath),
        this.git(['config', '--get', `branch.${branch}.merge`], worktreePath)
      ])
      const remote = remoteStdout.trim()
      const mergeRef = mergeStdout.trim()
      const branchRef = mergeRef.replace(/^refs\/heads\//, '')
      if (!remote || !branchRef || remote === '.' || branchRef === mergeRef) {
        return null
      }
      if (remote === 'origin' && branchRef !== branch) {
        return null
      }
      return { remote, refspec: `HEAD:${branchRef}` }
    } catch {
      return null
    }
  }

  private async readUnstagedLeftBlob(
    worktreePath: string,
    filePath: string
  ): Promise<DockerGitBlobReadResult> {
    const indexBlob = await this.readGitIndexBlob(worktreePath, filePath)
    if (indexBlob.exists) {
      return indexBlob
    }
    return this.readGitBlob(worktreePath, 'HEAD', filePath)
  }

  private async readGitIndexBlob(
    worktreePath: string,
    filePath: string
  ): Promise<DockerGitBlobReadResult> {
    return this.readGitBlobSpec(worktreePath, `:${filePath.replace(/\\/g, '/')}`, filePath)
  }

  private async readGitBlob(
    worktreePath: string,
    ref: string,
    filePath: string
  ): Promise<DockerGitBlobReadResult> {
    return this.readGitBlobSpec(worktreePath, `${ref}:${filePath.replace(/\\/g, '/')}`, filePath)
  }

  private async readGitBlobSpec(
    worktreePath: string,
    spec: string,
    filePath?: string
  ): Promise<DockerGitBlobReadResult> {
    try {
      const result = await this.git(
        ['show', '--no-textconv', '--end-of-options', spec],
        worktreePath
      )
      return { ...stringToBlob(result.stdout, filePath), exists: true }
    } catch {
      return { content: '', isBinary: false, exists: false }
    }
  }

  private async readWorkingTreeFile(
    worktreePath: string,
    filePath: string
  ): Promise<DockerGitBlobReadResult> {
    try {
      const result = await this.engine.exec({
        containerId: this.target.containerId,
        args: [
          'node',
          '-e',
          READ_GIT_WORKTREE_FILE_SCRIPT,
          filePath,
          String(MAX_DOCKER_GIT_BLOB_BYTES)
        ],
        cwd: this.worktreePath(worktreePath)
      })
      const parsed = JSON.parse(result.stdout) as { content: string; isBinary: boolean }
      return { ...parsed, exists: true }
    } catch {
      return { content: '', isBinary: false, exists: false }
    }
  }
}

type DockerGitBlobReadResult = {
  content: string
  isBinary: boolean
  exists: boolean
}

function parseStatus(
  stdout: string,
  conflictOperation: GitConflictOperation,
  includeIgnored: boolean
): GitStatusResult {
  const entries: GitStatusResult['entries'] = []
  const ignoredPaths: string[] = []
  let head: string | undefined
  let branch: string | undefined
  let upstreamName: string | undefined
  let upstreamAheadBehind: { ahead: number; behind: number } | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    if (line.startsWith('# branch.oid ')) {
      head = line.slice('# branch.oid '.length).trim() || undefined
      continue
    }
    if (line.startsWith('# branch.head ')) {
      const branchHead = line.slice('# branch.head '.length).trim()
      branch = branchHead && branchHead !== '(detached)' ? `refs/heads/${branchHead}` : undefined
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      upstreamName = line.slice('# branch.upstream '.length).trim() || undefined
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      upstreamAheadBehind = parseBranchAheadBehind(line)
      continue
    }
    if (line.startsWith('? ')) {
      entries.push({ path: line.slice(2), status: 'untracked', area: 'untracked' })
      continue
    }
    if (line.startsWith('! ')) {
      ignoredPaths.push(line.slice(2))
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const filePath = line.startsWith('2 ') ? line.split('\t')[1] : parts.slice(8).join(' ')
      if (xy[0] !== '.') {
        entries.push({ path: filePath, status: parseFileStatus(xy[0]), area: 'staged' })
      }
      if (xy[1] !== '.') {
        entries.push({ path: filePath, status: parseFileStatus(xy[1]), area: 'unstaged' })
      }
      continue
    }
    if (line.startsWith('u ')) {
      const entry = parseUnmergedStatusLine(line)
      if (entry) {
        entries.push(entry)
      }
    }
  }
  return {
    entries,
    conflictOperation,
    head,
    branch,
    ...(includeIgnored ? { ignoredPaths } : {}),
    upstreamStatus: upstreamName
      ? {
          hasUpstream: true,
          upstreamName,
          ahead: upstreamAheadBehind?.ahead ?? 0,
          behind: upstreamAheadBehind?.behind ?? 0
        }
      : { hasUpstream: false, ahead: 0, behind: 0 }
  }
}

function parseBranchAheadBehind(line: string): { ahead: number; behind: number } | null {
  const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
  if (!match) {
    return null
  }
  return {
    ahead: Number.parseInt(match[1], 10),
    behind: Number.parseInt(match[2], 10)
  }
}

function parseFileStatus(char: string): GitFileStatus {
  switch (char) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

function parseBranchStatus(char: string): 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' {
  return parseFileStatus(char[0]) as 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'
}

function parseBranchChangeLine(line: string): GitBranchChangeEntry | null {
  const parts = line.split('\t')
  const rawStatus = parts[0] ?? ''
  const status = parseBranchStatus(rawStatus) as GitBranchChangeStatus

  if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
    const oldPath = parts[1]
    const filePath = parts[2]
    if (!filePath) {
      return null
    }
    return { path: filePath, oldPath, status }
  }

  const filePath = parts[1]
  if (!filePath) {
    return null
  }
  return { path: filePath, status }
}

function parseBranchChanges(stdout: string): GitBranchChangeEntry[] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseBranchChangeLine)
    .filter((entry): entry is GitBranchChangeEntry => entry !== null)
}

function parseUnmergedStatusLine(line: string): GitStatusEntry | null {
  const parts = line.split(' ')
  const xy = parts[1]
  const filePath = parts.slice(10).join(' ')
  if (!xy || !filePath) {
    return null
  }
  const conflictKind = parseConflictKind(xy)
  if (!conflictKind) {
    return null
  }

  return {
    path: filePath,
    area: 'unstaged',
    status: conflictKind === 'both_deleted' ? 'deleted' : 'modified',
    conflictKind,
    conflictStatus: 'unresolved'
  }
}

function parseConflictKind(xy: string): GitConflictKind | null {
  switch (xy) {
    case 'UU':
      return 'both_modified'
    case 'AA':
      return 'both_added'
    case 'DD':
      return 'both_deleted'
    case 'AU':
      return 'added_by_us'
    case 'UA':
      return 'added_by_them'
    case 'DU':
      return 'deleted_by_us'
    case 'UD':
      return 'deleted_by_them'
    default:
      return null
  }
}

function buildTextDiffResult(originalContent: string, modifiedContent: string): GitDiffResult {
  return {
    kind: 'text',
    originalContent,
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

function buildDiffResult(
  originalContent: string,
  modifiedContent: string,
  originalIsBinary: boolean,
  modifiedIsBinary: boolean,
  filePath?: string
): GitDiffResult {
  if (originalIsBinary || modifiedIsBinary) {
    const mimeType = filePath
      ? PREVIEWABLE_BINARY_MIME_TYPES[pathExtname(filePath).toLowerCase()]
      : undefined
    return {
      kind: 'binary',
      originalContent,
      modifiedContent,
      originalIsBinary,
      modifiedIsBinary,
      ...(mimeType ? { isImage: true, mimeType } : {})
    } as GitDiffResult
  }
  return buildTextDiffResult(originalContent, modifiedContent)
}

function stringToBlob(content: string, filePath?: string): Omit<DockerGitBlobReadResult, 'exists'> {
  const buffer = Buffer.from(content, 'utf8')
  const isBinary = isBinaryBuffer(buffer)
  const isPreviewableBinary = filePath
    ? !!PREVIEWABLE_BINARY_MIME_TYPES[pathExtname(filePath).toLowerCase()]
    : false
  return {
    content: isBinary ? (isPreviewableBinary ? buffer.toString('base64') : '') : content,
    isBinary
  }
}

function pathExtname(filePath: string): string {
  const basename = filePath.split(/[\\/]/).at(-1) ?? filePath
  const dotIndex = basename.lastIndexOf('.')
  return dotIndex >= 0 ? basename.slice(dotIndex) : ''
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function getGitErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Git command failed'
  }
  const candidate = error as Error & { stdout?: string; stderr?: string }
  return candidate.stderr || candidate.stdout || error.message
}

function explicitPushTarget(target: GitPushTarget): { remote: string; refspec: string } {
  return { remote: target.remoteName, refspec: `HEAD:${target.branchName}` }
}

const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

const READ_GIT_WORKTREE_FILE_SCRIPT = `
const fs = require('fs');
const filePath = process.argv[1];
const maxBytes = Number(process.argv[2]);
const stat = fs.statSync(filePath);
if (stat.size > maxBytes) throw new Error('Git file is too large to read through Docker provider');
const buffer = fs.readFileSync(filePath);
const isBinary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
process.stdout.write(JSON.stringify({ content: isBinary ? '' : buffer.toString('utf8'), isBinary }));
`

function parseWorktrees(stdout: string): GitWorktreeInfo[] {
  const chunks = stdout.split(/\n\n+/).filter(Boolean)
  return chunks.map((chunk, index) => {
    const values = Object.fromEntries(
      chunk.split(/\r?\n/).map((line) => {
        const [key, ...rest] = line.split(' ')
        return [key, rest.join(' ')]
      })
    )
    return {
      path: values.worktree,
      head: values.HEAD,
      branch: values.branch?.replace(/^refs\/heads\//, '') ?? '',
      isBare: chunk.includes('\nbare'),
      isMainWorktree: index === 0
    }
  })
}
