/* eslint-disable max-lines -- Why: centralizes the git RPC protocol surface so local and SSH git behavior stay in one dispatch table. */
import { execFile, spawn, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { RelayContext } from './context'
import { expandTilde } from './context'
import {
  isUnsupportedWorktreeListZError,
  parseBranchDiff,
  parseWorktreeList
} from './git-handler-utils'
import { parseNumstat } from '../shared/git-uncommitted-line-stats'
import {
  computeDiff,
  branchCompare as branchCompareOp,
  branchDiffEntries,
  validateGitExecArgs
} from './git-handler-ops'
import {
  buildSubmoduleInnerCommitRangeDiff,
  computeSubmodulePointerDiff,
  computeSubmoduleRangeEntries,
  clearSubmodulePathsCache,
  createSubmodulePathsCache,
  findContainingSubmodule,
  listSubmodulePathsCached,
  resolveSubmoduleWorktreePath,
  resolveSubmoduleCommitRange,
  type SubmodulePathsCache
} from './git-handler-submodule-ops'
import { commitCompare as commitCompareOp, commitDiffEntry } from './git-handler-commit-diff-ops'
import {
  areRelayWorktreePathsEqual,
  commitChangesRelay,
  addWorktreeOp,
  removeWorktreeOp,
  worktreeIsCleanOp
} from './git-handler-worktree-ops'
import { annotatePrunableWorktreesByExistence } from './git-handler-worktree-list'
import { forceDeletePreservedRelayBranch } from './git-handler-branch-cleanup'
import { refreshLocalBaseRefForWorktreeCreateOp } from './git-handler-local-base-ref-refresh'
import { gitExecMutatesRepository } from '../shared/git-exec-mutation'
import { detectConflictOperation, getStatusOp } from './git-handler-status-ops'
import { checkIgnoredPathsOp } from './git-handler-check-ignore'
import { resolveRelayPushTarget } from './git-handler-push-target'
import {
  isNoUpstreamError,
  normalizeGitErrorMessage,
  runPullWithDivergenceFallback
} from '../shared/git-remote-error'
import { upstreamOnlyCommitsArePatchEquivalent } from '../shared/git-upstream-status'
import { assertGitPushTargetShape } from '../shared/git-push-target-validation'
import { getPublishTargetStatus, type GitCommandRunner } from '../shared/git-publish-target-status'
import { resolveGitRemoteRebaseSource } from '../shared/git-rebase-source'
import type { GitPushTarget } from '../shared/types'
import {
  getEffectiveGitUpstreamStatus,
  resolveEffectiveGitUpstream
} from '../shared/git-effective-upstream'
import { loadGitHistoryFromExecutor } from '../shared/git-history'
import { buildRelayGitEnv, buildRelayUnattendedGitEnv } from './relay-command-env'
import {
  removeSafeUntrackedDiscardTarget,
  removeSafeUntrackedDiscardTargets
} from '../shared/git-discard-path-safety'
import { getGitCloneFailureMessage } from '../shared/git-clone-failure-message'
import { syncForkDefaultBranch, validateGitForkSyncExpectedUpstream } from '../shared/git-fork-sync'
import { InFlightPromiseDedupe, stableInFlightKey } from '../shared/in-flight-promise-dedupe'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../shared/git-fetch-auto-maintenance'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import type { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedRevParsePathFormatError
} from '../shared/git-worktree-command-capabilities'
import { GitResponseStreamRegistry } from './git-response-stream'
import { GIT_RESPONSE_STREAM_THRESHOLD } from './protocol'
import { endSubprocessStdin } from '../shared/subprocess-stdin-write'
import { clearGitStatusLineStatsCache } from '../shared/git-status-line-stats-cache'

const execFileAsync = promisify(execFile)
const MAX_GIT_BUFFER = 10 * 1024 * 1024
const BULK_CHUNK_SIZE = 100

function resolveSubmoduleStatusArea(
  params: Record<string, unknown>
): 'staged' | 'unstaged' | 'untracked' {
  if (params.area === 'staged' || params.area === 'unstaged' || params.area === 'untracked') {
    return params.area
  }
  return 'unstaged'
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function resolveRelayPath(repoPath: string, value: string): string {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value
  }
  // Old git ignores `--path-format=absolute`; resolve relative toplevel/git-dir against repoPath, picking the win32/posix resolver by its shape.
  return isWindowsAbsolutePath(repoPath)
    ? path.win32.resolve(repoPath, value)
    : path.posix.resolve(repoPath, value)
}

type RelayRepoLocation = { topLevel: string; commonDir: string }

function parseRelayRepoLocation(repoPath: string, output: string): RelayRepoLocation | undefined {
  // Old git (pre `--path-format`) echoes the unknown flag and exits 0; drop `-`-prefixed lines, take the last two paths.
  // Strip only the trailing CR, not surrounding spaces — git paths may legitimately start or end with a space.
  const lines = output
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0 && !line.startsWith('-'))
  if (lines.length < 2) {
    return undefined
  }
  const [topLevel, commonDir] = lines.slice(-2)
  return {
    topLevel: resolveRelayPath(repoPath, topLevel),
    commonDir: resolveRelayPath(repoPath, commonDir)
  }
}

function execFileWithStdin(
  command: string,
  args: string[],
  options: ExecFileOptions,
  stdin: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (
      error: Error | null,
      stdout: string | Buffer = '',
      stderr: string | Buffer = ''
    ): void => {
      if (settled) {
        return
      }
      settled = true
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    }
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        finish(error, stdout, stderr)
        return
      }
      finish(null, stdout, stderr)
    })
    child.once('error', (error) => finish(error))
    endSubprocessStdin(child.stdin, stdin)
  })
}

export class GitHandler {
  private dispatcher: RelayDispatcher
  private readonly gitDiffReadDedupe = new InFlightPromiseDedupe<unknown>()
  private readonly gitCapabilities = new GitCapabilityCache()
  // Why: large diff/exec responses go on the bulk lane so they don't head-of-line-block interactive pty.data echo on the shared SSH channel.
  private readonly responseStreams = new GitResponseStreamRegistry()

  // Why: instance-level TTL cache avoids re-reading `.gitmodules` per diff click over SSH; per-instance so it can't leak across tests.
  private submodulePathsCache: SubmodulePathsCache = createSubmodulePathsCache()

  // Why: RelayContext accepted for protocol back-compat (docs/relay-fs-allowlist-removal.md) but no longer consulted on git ops.
  constructor(
    dispatcher: RelayDispatcher,
    _context: RelayContext,
    private readonly watcherRegistry?: Pick<RelayFilesystemWatchRegistry, 'runWithRemovalFence'>
  ) {
    this.dispatcher = dispatcher
    this.registerHandlers()
    // Why: a detached client's git.responseAck frames never arrive; wake any pump parked on the ack window so it re-checks staleness and exits.
    this.dispatcher.onClientDetached?.(() => this.responseStreams.wakeAll())
  }

  dispose(): void {
    this.responseStreams.disposeAll()
    this.clearGitMutationReadCaches()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('git.status', (p, context) => this.getStatus(p, context))
    this.dispatcher.onRequest('git.submoduleStatus', (p) => this.getSubmoduleStatus(p))
    this.dispatcher.onRequest('git.checkIgnored', (p) => this.checkIgnored(p))
    this.dispatcher.onRequest('git.history', (p) => this.history(p))
    this.dispatcher.onRequest('git.commit', (p) => this.commit(p))
    this.dispatcher.onRequest('git.diff', (p, context) => this.getDiff(p, context))
    this.dispatcher.onRequest('git.stage', (p) => this.stage(p))
    this.dispatcher.onRequest('git.unstage', (p) => this.unstage(p))
    this.dispatcher.onRequest('git.bulkStage', (p) => this.bulkStage(p))
    this.dispatcher.onRequest('git.bulkUnstage', (p) => this.bulkUnstage(p))
    this.dispatcher.onRequest('git.abortMerge', (p) => this.abortMerge(p))
    this.dispatcher.onRequest('git.abortRebase', (p) => this.abortRebase(p))
    this.dispatcher.onRequest('git.checkout', (p) => this.checkout(p))
    this.dispatcher.onRequest('git.localBranches', (p) => this.localBranches(p))
    this.dispatcher.onRequest('git.discard', (p) => this.discard(p))
    this.dispatcher.onRequest('git.bulkDiscard', (p) => this.bulkDiscard(p))
    this.dispatcher.onRequest('git.conflictOperation', (p) => this.conflictOperation(p))
    this.dispatcher.onRequest('git.branchCompare', (p) => this.branchCompare(p))
    this.dispatcher.onRequest('git.commitCompare', (p) => this.commitCompare(p))
    this.dispatcher.onRequest('git.upstreamStatus', (p) => this.upstreamStatus(p))
    this.dispatcher.onRequest('git.fetch', (p) => this.fetch(p))
    this.dispatcher.onRequest('git.forkSync', (p, context) => this.forkSync(p, context))
    this.dispatcher.onRequest('git.fetchRemoteTrackingRef', (p) => this.fetchRemoteTrackingRef(p))
    this.dispatcher.onRequest('git.fetchGitLabMergeRequestHead', (p) =>
      this.fetchGitLabMergeRequestHead(p)
    )
    this.dispatcher.onRequest('git.push', (p) => this.push(p))
    this.dispatcher.onRequest('git.pull', (p) => this.pull(p))
    this.dispatcher.onRequest('git.fastForward', (p) => this.fastForward(p))
    this.dispatcher.onRequest('git.rebaseFromBase', (p) => this.rebaseFromBase(p))
    this.dispatcher.onRequest('git.branchDiff', (p, context) => this.branchDiff(p, context))
    this.dispatcher.onRequest('git.commitDiff', (p, context) => this.commitDiff(p, context))
    this.dispatcher.onRequest('git.listWorktrees', (p, context) => this.listWorktrees(p, context))
    this.dispatcher.onRequest('git.addWorktree', (p) => this.addWorktree(p))
    this.dispatcher.onRequest('git.removeWorktree', (p) => this.removeWorktree(p))
    this.dispatcher.onRequest('git.worktreeIsClean', (p) => this.worktreeIsClean(p))
    this.dispatcher.onRequest('git.refreshLocalBaseRefForWorktreeCreate', (p) =>
      this.refreshLocalBaseRefForWorktreeCreate(p)
    )
    this.dispatcher.onRequest('git.renameCurrentBranch', (p) => this.renameCurrentBranch(p))
    this.dispatcher.onRequest('git.forceDeletePreservedBranch', (p) =>
      this.forceDeletePreservedBranch(p)
    )
    this.dispatcher.onRequest('git.exec', (p, context) => this.exec(p, context))
    this.dispatcher.onRequest('git.clone', (p, context) => this.clone(p, context))
    this.dispatcher.onRequest('git.isGitRepo', (p) => this.isGitRepo(p))
    this.dispatcher.onNotification('git.responseAck', (p, context) => this.responseAck(p, context))
    this.dispatcher.onNotification('git.cancelResponseStream', (p, context) =>
      this.cancelResponseStream(p, context)
    )
  }

  private responseAck(params: Record<string, unknown>, context: RequestContext): void {
    const streamId = params.streamId
    const seq = params.seq
    if (typeof streamId === 'number' && typeof seq === 'number') {
      this.responseStreams.recordAck(streamId, seq, context.clientId)
    }
  }

  private cancelResponseStream(params: Record<string, unknown>, context: RequestContext): void {
    const streamId = params.streamId
    if (typeof streamId === 'number') {
      this.responseStreams.abort(streamId, context.clientId)
    }
  }

  // Why: opt-in streaming — old clients/relays omit the flag and fall back to the plain result.
  private maybeStreamResponse(
    result: unknown,
    params: Record<string, unknown>,
    context: RequestContext | undefined
  ): unknown {
    if (params.__streamResponse !== true || !context) {
      return result
    }
    const payload = Buffer.from(JSON.stringify(result ?? null), 'utf-8')
    if (payload.length <= GIT_RESPONSE_STREAM_THRESHOLD) {
      return result
    }
    return this.responseStreams.startStream(payload, this.dispatcher, context)
  }

  private clearGitMutationReadCaches(): void {
    this.gitDiffReadDedupe.clear()
    clearGitStatusLineStatsCache()
    clearSubmodulePathsCache(this.submodulePathsCache)
  }

  private async runWithGitReadCacheClear<T>(run: () => Promise<T>): Promise<T> {
    // Why: git mutations can stale in-flight diff/.gitmodules reads; clear before and after so later reads cannot join them.
    this.clearGitMutationReadCaches()
    try {
      return await run()
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async git(
    args: string[],
    cwd: string,
    opts?: {
      maxBuffer?: number
      disableOptionalLocks?: boolean
      signal?: AbortSignal
      nonInteractive?: boolean
      stdin?: string
      timeout?: number
    }
  ): Promise<{ stdout: string; stderr: string }> {
    const env = opts?.nonInteractive ? buildRelayUnattendedGitEnv() : buildRelayGitEnv()
    if (opts?.disableOptionalLocks) {
      env.GIT_OPTIONAL_LOCKS = '0'
    }
    const execOptions = {
      cwd: expandTilde(cwd),
      env,
      encoding: 'utf-8',
      maxBuffer: opts?.maxBuffer ?? MAX_GIT_BUFFER,
      timeout: opts?.timeout,
      signal: opts?.signal
    } satisfies ExecFileOptions
    if (opts?.stdin !== undefined) {
      return execFileWithStdin('git', args, execOptions, opts.stdin)
    }
    const { stdout, stderr } = await execFileAsync('git', args, execOptions)
    return { stdout: String(stdout), stderr: String(stderr) }
  }

  private async gitBuffer(args: string[], cwd: string): Promise<Buffer> {
    const { stdout } = (await execFileAsync('git', args, {
      cwd,
      env: buildRelayGitEnv(),
      encoding: 'buffer',
      maxBuffer: MAX_GIT_BUFFER
    })) as { stdout: Buffer }
    return stdout
  }

  private async getStatus(params: Record<string, unknown>, context: RequestContext) {
    this.gitDiffReadDedupe.clear()
    return getStatusOp(this.git.bind(this), params, { signal: context.signal })
  }

  // Why: parent status lists one gitlink row per submodule; fetch inner per-file changes by running status inside the submodule's own worktree.
  private async getSubmoduleStatus(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const submodulePath = params.submodulePath as string
    const area = resolveSubmoduleStatusArea(params)
    const staged = area === 'staged'
    const resolved = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
    const workingResult = await getStatusOp(this.git.bind(this), {
      ...params,
      worktreePath: resolved
    })
    // Why: a moved gitlink (clean worktree) has no uncommitted rows; surface files changed between recorded and checked-out commits so it isn't empty.
    const { fromOid, toOid } = await resolveSubmoduleCommitRange(
      this.git.bind(this),
      worktreePath,
      submodulePath,
      staged
    )
    if (fromOid && toOid && fromOid !== toOid) {
      const rangeEntries = await computeSubmoduleRangeEntries(
        this.git.bind(this),
        resolved,
        fromOid,
        toOid
      )
      if (staged) {
        return { ...workingResult, entries: rangeEntries }
      }
      const rangePaths = new Set(rangeEntries.map((entry) => entry.path))
      const entries = [
        ...rangeEntries,
        ...workingResult.entries.filter((entry) => !rangePaths.has(entry.path))
      ]
      return { ...workingResult, entries }
    }
    if (staged) {
      return { ...workingResult, entries: [] }
    }
    return workingResult
  }

  private async checkIgnored(params: Record<string, unknown>) {
    return checkIgnoredPathsOp(this.git.bind(this), params)
  }

  private async history(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    return loadGitHistoryFromExecutor(this.git.bind(this), worktreePath, {
      limit: typeof params.limit === 'number' ? params.limit : undefined,
      baseRef: typeof params.baseRef === 'string' ? params.baseRef : null
    })
  }

  private async getDiff(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    // Why: filePath is relative and joined for readWorkingFile; validate or `../../etc/passwd` traverses outside the worktree.
    const resolved = path.resolve(worktreePath, filePath)
    const rel = path.relative(path.resolve(worktreePath), resolved)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }
    const staged = params.staged as boolean
    const compareAgainstHead = params.compareAgainstHead as boolean | undefined
    // Why: register the in-flight dedupe synchronously (before any await) so concurrent identical reads coalesce; submodule routing happens inside.
    const result = await this.gitDiffReadDedupe.run(
      stableInFlightKey(['diff', worktreePath, filePath, staged, compareAgainstHead]),
      async () => {
        // Why: gitlinks can't be read as blobs, so route the gitlink root to a pointer diff and inner files into the submodule's own worktree.
        const submodulePaths = await listSubmodulePathsCached(
          this.git.bind(this),
          worktreePath,
          this.submodulePathsCache
        )
        if (submodulePaths.length > 0) {
          const matchedSubmodule = findContainingSubmodule(submodulePaths, filePath)
          if (matchedSubmodule) {
            const normalizedFilePath = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
            if (normalizedFilePath === matchedSubmodule) {
              return computeSubmodulePointerDiff(
                this.git.bind(this),
                worktreePath,
                matchedSubmodule,
                staged,
                compareAgainstHead
              )
            }
            const submoduleWorktreePath = resolveSubmoduleWorktreePath(
              worktreePath,
              matchedSubmodule
            )
            const innerPath = normalizedFilePath.slice(matchedSubmodule.length + 1)
            const { fromOid, toOid } = await resolveSubmoduleCommitRange(
              this.git.bind(this),
              worktreePath,
              matchedSubmodule,
              staged
            )
            // Why: a moved gitlink (clean worktree) keeps inner changes in committed history, so diff the two commits; otherwise read the working-tree blob.
            if (fromOid && toOid && fromOid !== toOid) {
              return buildSubmoduleInnerCommitRangeDiff(
                this.gitBuffer.bind(this),
                submoduleWorktreePath,
                innerPath,
                fromOid,
                toOid
              )
            }
            return computeDiff(
              this.gitBuffer.bind(this),
              submoduleWorktreePath,
              innerPath,
              staged,
              compareAgainstHead
            )
          }
        }
        return computeDiff(
          this.gitBuffer.bind(this),
          worktreePath,
          filePath,
          staged,
          compareAgainstHead
        )
      }
    )
    return this.maybeStreamResponse(result, params, context)
  }

  private async stage(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    try {
      await this.git(['add', '--', this.literalPathspec(filePath)], worktreePath)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async commit(
    params: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const message = params.message as string
    try {
      return await commitChangesRelay(this.git.bind(this), worktreePath, message)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async unstage(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    try {
      await this.git(['restore', '--staged', '--', this.literalPathspec(filePath)], worktreePath)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async bulkStage(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    try {
      for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
        const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
        await this.git(
          ['add', '--', ...chunk.map((filePath) => this.literalPathspec(filePath))],
          worktreePath
        )
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async bulkUnstage(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    try {
      for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
        const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
        await this.git(
          ['restore', '--staged', '--', ...chunk.map((filePath) => this.literalPathspec(filePath))],
          worktreePath
        )
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async abortMerge(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    try {
      await this.git(['merge', '--abort'], worktreePath)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async abortRebase(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    try {
      await this.git(['rebase', '--abort'], worktreePath)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async checkout(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const branch = params.branch as string
    // Defense-in-depth: reject `-`-prefixed branch tokens to block flag injection (this relay entrypoint is reachable independently of the RPC schema).
    if (typeof branch !== 'string' || branch.length === 0 || branch.startsWith('-')) {
      throw new Error('invalid_branch_name')
    }
    try {
      await this.git(['checkout', branch, '--'], worktreePath)
      return { ok: true as const, branch }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async localBranches(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const { stdout } = await this.git(
      ['for-each-ref', '--format=%(HEAD)%09%(refname:short)', 'refs/heads/'],
      worktreePath
    )
    let current: string | null = null
    const branches: string[] = []
    for (const line of stdout.split('\n')) {
      if (line.length === 0) {
        continue
      }
      const [marker, name] = line.split('\t')
      if (!name) {
        continue
      }
      if (marker === '*') {
        current = name
      }
      branches.push(name)
    }
    branches.sort((a, b) => (a === current ? -1 : b === current ? 1 : 0))
    return { current, branches }
  }

  private normalizeGitPathForCompare(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  private isTrackedPathSpec(filePath: string, trackedPaths: readonly string[]): boolean {
    const normalized = this.normalizeGitPathForCompare(filePath)
    return trackedPaths.some((trackedPath) => {
      const normalizedTracked = this.normalizeGitPathForCompare(trackedPath)
      return normalizedTracked === normalized || normalizedTracked.startsWith(`${normalized}/`)
    })
  }

  private assertInWorktree(worktreePath: string, filePath: string): string {
    const resolved = path.resolve(worktreePath, filePath)
    const rel = path.relative(path.resolve(worktreePath), resolved)
    // Why: empty rel or '.' means the path IS the worktree root; reject (with parent-escaping paths) so a discard can't wipe the whole worktree.
    if (
      !rel ||
      rel === '.' ||
      rel === '..' ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }
    return resolved
  }

  private async discard(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    try {
      this.assertInWorktree(worktreePath, filePath)

      let tracked = false
      try {
        await this.git(
          ['ls-files', '--error-unmatch', '--', this.literalPathspec(filePath)],
          worktreePath
        )
        tracked = true
      } catch {
        // untracked
      }

      if (tracked) {
        await this.git(
          ['restore', '--worktree', '--source=HEAD', '--', this.literalPathspec(filePath)],
          worktreePath
        )
        return
      }

      await removeSafeUntrackedDiscardTarget(worktreePath, filePath, (targetPath) =>
        this.cleanUntrackedPaths(worktreePath, [targetPath])
      )
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async bulkDiscard(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    if (filePaths.length === 0) {
      return
    }
    try {
      for (const filePath of filePaths) {
        this.assertInWorktree(worktreePath, filePath)
      }

      const trackedPathSpecs: string[] = []
      for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
        const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
        const { stdout } = await this.git(
          ['ls-files', '-z', '--', ...chunk.map((p) => this.literalPathspec(p))],
          worktreePath
        )
        // Why: a selected tracked directory can make `ls-files -z` return enough descendants for push(...split) to exceed the argument limit.
        for (const trackedPathSpec of stdout.split('\0')) {
          if (trackedPathSpec) {
            trackedPathSpecs.push(trackedPathSpec)
          }
        }
      }

      const trackedPaths = filePaths.filter((filePath) =>
        this.isTrackedPathSpec(filePath, trackedPathSpecs)
      )
      const untrackedPaths = filePaths.filter(
        (filePath) => !this.isTrackedPathSpec(filePath, trackedPathSpecs)
      )
      await removeSafeUntrackedDiscardTargets(
        worktreePath,
        untrackedPaths,
        (targetPaths) => this.cleanUntrackedPaths(worktreePath, targetPaths),
        async () => {
          for (let i = 0; i < trackedPaths.length; i += BULK_CHUNK_SIZE) {
            const chunk = trackedPaths.slice(i, i + BULK_CHUNK_SIZE)
            await this.git(
              [
                'restore',
                '--worktree',
                '--source=HEAD',
                '--',
                ...chunk.map((p) => this.literalPathspec(p))
              ],
              worktreePath
            )
          }
        }
      )
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private literalPathspec(filePath: string): string {
    // Why: source-control selections are concrete paths, not user-authored Git globs.
    return `:(literal)${filePath}`
  }

  private async cleanUntrackedPaths(worktreePath: string, filePaths: readonly string[]) {
    for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
      if (chunk.length > 0) {
        // Why: Git pathspec cleanup avoids raw recursive deletion through symlinked parents.
        await this.git(
          ['clean', '-ffdx', '--', ...chunk.map((p) => this.literalPathspec(p))],
          worktreePath
        )
      }
    }
  }

  private async conflictOperation(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    return detectConflictOperation(worktreePath)
  }

  private async branchCompare(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    // Why: a baseRef starting with '-' would be read as a git rev-parse flag, potentially leaking environment variables or config.
    if (baseRef.startsWith('-')) {
      throw new Error('Base ref must not start with "-"')
    }
    const gitBound = this.git.bind(this)
    return branchCompareOp(gitBound, worktreePath, baseRef, async (mergeBase, headOid) => {
      // Why: -c core.quotePath=false keeps non-ASCII filenames as raw UTF-8; without it parseBranchDiff would get C-style octal-escaped paths.
      const { stdout } = await gitBound(
        ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', mergeBase, headOid],
        worktreePath
      )
      const { stdout: numstat } = await gitBound(
        ['-c', 'core.quotePath=false', 'diff', '--numstat', '-M', '-C', mergeBase, headOid],
        worktreePath
      )
      return parseBranchDiff(stdout, parseNumstat(numstat))
    })
  }

  private async commitCompare(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const commitId = params.commitId as string
    return commitCompareOp(this.git.bind(this), worktreePath, commitId)
  }

  private async upstreamStatus(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string

    try {
      if (params.pushTarget !== undefined) {
        assertGitPushTargetShape(params.pushTarget)
        const pushTarget = params.pushTarget as GitPushTarget
        await this.git(['check-ref-format', '--branch', pushTarget.branchName], worktreePath)
        return await getPublishTargetStatus(
          ((args) => this.git(args, worktreePath)) as GitCommandRunner,
          pushTarget,
          (upstreamName) => this.getBehindCommitsArePatchEquivalent(worktreePath, upstreamName)
        )
      }
      return await getEffectiveGitUpstreamStatus(
        (args) => this.git(args, worktreePath),
        (upstreamName) => this.getBehindCommitsArePatchEquivalent(worktreePath, upstreamName)
      )
    } catch (error) {
      // Why: swallow only 'no upstream configured' (an expected state); other errors (auth, corruption, network) must surface to the user.
      if (isNoUpstreamError(error)) {
        return { hasUpstream: false, ahead: 0, behind: 0 }
      }
      // Why: match fetch/push/pull normalization so execFile preamble and local paths don't leak to the renderer.
      throw new Error(normalizeGitErrorMessage(error, 'upstream'))
    }
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
      return upstreamOnlyCommitsArePatchEquivalent(stdout)
    } catch {
      // Why: this only identifies stale post-rebase upstreams; if the probe fails over SSH, keep the conservative pull-first sync path.
      return false
    }
  }

  private async fetch(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    try {
      try {
        if (params.pushTarget !== undefined) {
          assertGitPushTargetShape(params.pushTarget)
          const pushTarget = params.pushTarget as GitPushTarget
          await this.git(['check-ref-format', '--branch', pushTarget.branchName], worktreePath)
          await this.git(['fetch', '--prune', pushTarget.remoteName], worktreePath)
          return
        }
        await this.git(['fetch', '--prune'], worktreePath)
      } catch (error) {
        // Why: normalize like local gitFetch so SSH users get actionable messages, not raw stderr (may embed credentials).
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async forkSync(params: Record<string, unknown>, context?: RequestContext) {
    return this.runWithGitReadCacheClear(async () => {
      const worktreePath = params.worktreePath as string
      const expectedUpstream = validateGitForkSyncExpectedUpstream(params.expectedUpstream, {
        required: true
      })
      const controller = new AbortController()
      const abortFromContext = () => controller.abort()
      if (context?.signal?.aborted) {
        controller.abort()
      } else {
        context?.signal?.addEventListener('abort', abortFromContext, { once: true })
      }
      const timeout = setTimeout(() => controller.abort(), 60_000)
      try {
        return await syncForkDefaultBranch(
          (args) =>
            this.git(args, worktreePath, {
              nonInteractive: true,
              signal: controller.signal
            }),
          { expectedUpstream }
        )
      } catch (error) {
        throw new Error(normalizeGitErrorMessage(error, 'push'))
      } finally {
        clearTimeout(timeout)
        context?.signal?.removeEventListener('abort', abortFromContext)
      }
    })
  }

  private async fetchRemoteTrackingRef(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const remote = params.remote
    const branch = params.branch
    const ref = params.ref
    const skipAutoMaintenance = params.skipAutoMaintenance
    try {
      if (typeof remote !== 'string' || typeof branch !== 'string' || typeof ref !== 'string') {
        throw new Error('Invalid remote-tracking fetch request.')
      }
      if (skipAutoMaintenance !== undefined && typeof skipAutoMaintenance !== 'boolean') {
        throw new Error('Invalid remote-tracking fetch maintenance option.')
      }
      if (remote.startsWith('-') || branch.startsWith('-')) {
        throw new Error('Remote-tracking fetch inputs must not start with "-".')
      }
      if (ref !== `refs/remotes/${remote}/${branch}`) {
        throw new Error('Remote-tracking ref does not match the requested remote and branch.')
      }

      try {
        const { stdout } = await this.git(['remote'], worktreePath)
        const remotes = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        if (!remotes.includes(remote)) {
          throw new Error(`Remote "${remote}" is not configured.`)
        }
        await this.git(['check-ref-format', `refs/heads/${branch}`], worktreePath)
        await this.git(['check-ref-format', ref], worktreePath)
        await this.git(
          [
            ...(skipAutoMaintenance ? GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS : []),
            'fetch',
            '--no-tags',
            remote,
            `+refs/heads/${branch}:${ref}`
          ],
          worktreePath
        )
      } catch (error) {
        // Why: create-worktree needs a write-capable fetch that generic git.exec rejects; narrow RPC keeps the allowlist tight.
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async fetchGitLabMergeRequestHead(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const remote = params.remote
    const mrIid = params.mrIid
    try {
      if (typeof remote !== 'string') {
        throw new Error('Invalid GitLab merge request fetch request.')
      }
      if (typeof mrIid !== 'number' || !Number.isSafeInteger(mrIid) || mrIid <= 0) {
        throw new Error('Invalid GitLab merge request fetch request.')
      }
      const mergeRequestIid = mrIid
      if (remote.startsWith('-')) {
        throw new Error('GitLab merge request fetch remote must not start with "-".')
      }

      try {
        const { stdout } = await this.git(['remote'], worktreePath)
        const remotes = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        if (!remotes.includes(remote)) {
          throw new Error(`Remote "${remote}" is not configured.`)
        }
        // Why: GitLab MR heads aren't refs/heads/*, so the remote-tracking fetch RPC can't represent fork MRs; keep this write path MR-only.
        await this.git(
          ['fetch', '--no-tags', remote, `refs/merge-requests/${mergeRequestIid}/head`],
          worktreePath
        )
      } catch (error) {
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async push(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    // Why: mirror src/main/git/remote.ts — push to a configured upstream when present so SSH worktrees with non-origin targets aren't repointed.
    void params.publish
    try {
      try {
        const target = await resolveRelayPushTarget(
          this.git.bind(this),
          worktreePath,
          params.pushTarget
        )
        const args = [
          'push',
          ...(params.forceWithLease === true ? ['--force-with-lease'] : []),
          '--set-upstream',
          ...(target ? [target.remote, target.refspec] : ['origin', 'HEAD'])
        ]
        await this.git(args, worktreePath)
      } catch (error) {
        // Why: mirror local gitPush normalization so SSH users get "non-fast-forward / pull first" guidance instead of raw git stderr.
        throw new Error(normalizeGitErrorMessage(error, 'push'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async pullWithArgs(params: Record<string, unknown>, pullArgs: string[]) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const runPull = async (effectiveArgs: string[]): Promise<void> => {
      if (params.pushTarget !== undefined) {
        assertGitPushTargetShape(params.pushTarget)
        const pushTarget = params.pushTarget as GitPushTarget
        await this.git(['check-ref-format', '--branch', pushTarget.branchName], worktreePath)
        await this.git(
          ['pull', ...effectiveArgs, pushTarget.remoteName, pushTarget.branchName],
          worktreePath
        )
        return
      }
      const upstream = await resolveEffectiveGitUpstream((args) => this.git(args, worktreePath))
      if (upstream && !upstream.isConfiguredUpstream) {
        // Why: legacy Orca branches may track origin/main while pushes target origin/<branch>; pull the same effective branch the UI reports.
        await this.git(
          ['pull', ...effectiveArgs, upstream.remoteName, upstream.branchName],
          worktreePath
        )
        return
      }
      await this.git(['pull', ...effectiveArgs], worktreePath)
    }

    try {
      try {
        await runPullWithDivergenceFallback(pullArgs, runPull)
      } catch (error) {
        // Why: mirror local gitPull normalization so SSH users get actionable messages instead of raw git stderr.
        throw new Error(normalizeGitErrorMessage(error, 'pull'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async pull(params: Record<string, unknown>) {
    // Why: plain `git pull` honors the user's merge/rebase/ff policy; with none, Git's policy error is normalized with setup guidance.
    await this.pullWithArgs(params, [])
  }

  private async fastForward(params: Record<string, unknown>) {
    await this.pullWithArgs(params, ['--ff-only'])
  }

  private async rebaseFromBase(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    try {
      try {
        const source = await resolveGitRemoteRebaseSource(
          ((args) => this.git(args, worktreePath)) as GitCommandRunner,
          baseRef
        )
        await this.git(['pull', '--rebase', source.remoteName, source.branchName], worktreePath)
      } catch (error) {
        throw new Error(normalizeGitErrorMessage(error, 'pull'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async branchDiff(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    if (baseRef.startsWith('-')) {
      throw new Error('Base ref must not start with "-"')
    }
    const options = {
      includePatch: params.includePatch as boolean | undefined,
      filePath: params.filePath as string | undefined,
      oldPath: params.oldPath as string | undefined
    }
    const result = await this.gitDiffReadDedupe.run(
      stableInFlightKey([
        'branchDiff',
        worktreePath,
        baseRef,
        options.includePatch ?? null,
        options.filePath ?? null,
        options.oldPath ?? null
      ]),
      () =>
        branchDiffEntries(
          this.git.bind(this),
          this.gitBuffer.bind(this),
          worktreePath,
          baseRef,
          options
        )
    )
    return this.maybeStreamResponse(result, params, context)
  }

  private async commitDiff(params: Record<string, unknown>, context?: RequestContext) {
    const worktreePath = params.worktreePath as string
    const args = {
      commitOid: params.commitOid as string,
      parentOid: params.parentOid as string | null | undefined,
      filePath: params.filePath as string,
      oldPath: params.oldPath as string | undefined
    }
    const result = await this.gitDiffReadDedupe.run(
      stableInFlightKey([
        'commitDiff',
        worktreePath,
        args.commitOid,
        args.parentOid ?? null,
        args.filePath,
        args.oldPath ?? null
      ]),
      () => commitDiffEntry(this.gitBuffer.bind(this), worktreePath, args)
    )
    return this.maybeStreamResponse(result, params, context)
  }

  private async exec(params: Record<string, unknown>, context?: RequestContext) {
    const args = params.args as string[]
    const cwd = params.cwd as string

    validateGitExecArgs(args)
    const run = () => this.git(args, cwd, { signal: context?.signal })
    const { stdout, stderr } = gitExecMutatesRepository(args)
      ? await this.runWithGitReadCacheClear(run)
      : await run()
    return this.maybeStreamResponse({ stdout, stderr }, params, context)
  }

  private async clone(params: Record<string, unknown>, context?: RequestContext) {
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

  private async spawnClone(
    args: string[],
    cwd: string,
    progressId: string,
    context?: RequestContext
  ): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: expandTilde(cwd),
        env: buildRelayUnattendedGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const cleanup = (): void => {
        context?.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        child.kill()
      }
      context?.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf-8')).slice(-4096)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        stderr = (stderr + text).slice(-4096)
        for (const line of text.split(/[\r\n]+/)) {
          const match = line.match(/^([\w\s]+):\s+(\d+)%/)
          if (match) {
            this.dispatcher.notify('git.cloneProgress', {
              progressId,
              phase: match[1].trim(),
              percent: Number.parseInt(match[2], 10)
            })
          }
        }
      })
      child.on('error', (error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      })
      child.on('close', (code, signal) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (context?.signal?.aborted) {
          reject(new Error('Clone aborted'))
          return
        }
        if (code === 0 && !signal) {
          resolve({ stdout, stderr })
          return
        }
        reject(new Error(`Clone failed: ${getGitCloneFailureMessage(stderr)}`))
      })
    })
  }

  private async renameCurrentBranch(params: Record<string, unknown>) {
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

  private async forceDeletePreservedBranch(params: Record<string, unknown>) {
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

  private async isGitRepo(params: Record<string, unknown>) {
    const dirPath = params.dirPath as string
    try {
      const { stdout } = await this.git(['rev-parse', '--show-toplevel'], dirPath)
      return { isRepo: true, rootPath: stdout.trim() }
    } catch {
      return { isRepo: false, rootPath: null }
    }
  }

  private async readRepoLocation(repoPath: string): Promise<RelayRepoLocation | undefined> {
    try {
      return await this.gitCapabilities.runWithFallback(
        'rev-parse-path-format',
        async () => {
          const { stdout } = await this.git(
            ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
            repoPath
          )
          if (hasUnsupportedRevParsePathFormatEcho(stdout)) {
            // Why: old Git echoes the unknown option and exits zero; remember the signal though the paths still parse.
            this.gitCapabilities.rememberUnsupported('rev-parse-path-format')
          }
          return parseRelayRepoLocation(repoPath, stdout)
        },
        async () => {
          const { stdout } = await this.git(
            ['rev-parse', '--show-toplevel', '--git-common-dir'],
            repoPath
          )
          return parseRelayRepoLocation(repoPath, stdout)
        },
        isUnsupportedRevParsePathFormatError
      )
    } catch {
      return undefined
    }
  }

  private async normalizeMainWorktreePath(
    repoPath: string,
    worktrees: Record<string, unknown>[]
  ): Promise<Record<string, unknown>[]> {
    const mainIndex = worktrees.findIndex((worktree) => worktree.isMainWorktree === true)
    const mainWorktree = worktrees[mainIndex]
    const mainPath = typeof mainWorktree?.path === 'string' ? mainWorktree.path : ''
    // Expand `~` so legacy tilde SSH repo paths match git's absolute path, sparing a rev-parse per poll.
    const resolvedRepoPath = expandTilde(repoPath)
    if (!mainPath || areRelayWorktreePathsEqual(mainPath, resolvedRepoPath)) {
      return worktrees
    }

    const location = await this.readRepoLocation(resolvedRepoPath)
    if (!location) {
      return worktrees
    }

    // Why: only separate-git-dir/submodule repos have main entry == git-common-dir; gate on it so we don't clobber a linked worktree's real root.
    if (!areRelayWorktreePathsEqual(mainPath, location.commonDir)) {
      return worktrees
    }

    const normalized = [...worktrees]
    normalized[mainIndex] = { ...mainWorktree, path: location.topLevel }
    return normalized
  }

  private async listWorktrees(params: Record<string, unknown>, context?: RequestContext) {
    const repoPath = params.repoPath as string
    return this.gitCapabilities
      .runWithFallback(
        'worktree-list-z',
        async () => {
          const { stdout } = await this.git(['worktree', 'list', '--porcelain', '-z'], repoPath, {
            signal: context?.signal
          })
          return this.normalizeMainWorktreePath(
            repoPath,
            parseWorktreeList(stdout, { nulDelimited: true })
          )
        },
        async () => {
          // Why: Git <2.36 lacks worktree-list `-z`, so fall back to the newline-block parser (loses newline-in-path safety).
          try {
            const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoPath, {
              signal: context?.signal
            })
            const normalized = await this.normalizeMainWorktreePath(
              repoPath,
              parseWorktreeList(stdout)
            )
            // Why: Git <2.31 emits no `prunable` annotation, so probe each linked worktree's existence instead of trusting stale registrations (issue #8389).
            return annotatePrunableWorktreesByExistence(normalized)
          } catch {
            return []
          }
        },
        isUnsupportedWorktreeListZError
      )
      .catch(() => [])
  }

  private async addWorktree(params: Record<string, unknown>) {
    return this.runWithGitReadCacheClear(() => addWorktreeOp(this.git.bind(this), params))
  }

  private async removeWorktree(params: Record<string, unknown>) {
    const remove = () =>
      this.runWithGitReadCacheClear(() =>
        removeWorktreeOp(this.git.bind(this), params, this.gitCapabilities)
      )
    const worktreePath = params.worktreePath
    return this.watcherRegistry && typeof worktreePath === 'string'
      ? this.watcherRegistry.runWithRemovalFence(expandTilde(worktreePath), remove)
      : remove()
  }

  private async worktreeIsClean(params: Record<string, unknown>) {
    return worktreeIsCleanOp(this.git.bind(this), params)
  }

  private async refreshLocalBaseRefForWorktreeCreate(params: Record<string, unknown>) {
    return this.runWithGitReadCacheClear(() =>
      refreshLocalBaseRefForWorktreeCreateOp(this.git.bind(this), params, this.gitCapabilities)
    )
  }
}
