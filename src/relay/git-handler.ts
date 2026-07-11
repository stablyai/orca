/* eslint-disable max-lines -- Why: this relay handler centralizes the git RPC
protocol surface so local and SSH git behavior stay in one dispatch table. */
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
import { forceDeletePreservedRelayBranch } from './git-handler-branch-cleanup'
import { refreshLocalBaseRefForWorktreeCreateOp } from './git-handler-local-base-ref-refresh'
import { detectConflictOperation, getStatusOp } from './git-handler-status-ops'
import { checkIgnoredPathsOp } from './git-handler-check-ignore'
import { resolveRelayPushTarget } from './git-handler-push-target'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../shared/git-remote-error'
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
import { buildRelayGitEnv } from './relay-command-env'
import {
  removeSafeUntrackedDiscardTarget,
  removeSafeUntrackedDiscardTargets
} from '../shared/git-discard-path-safety'
import { getGitCloneFailureMessage } from '../shared/git-clone-failure-message'
import { syncForkDefaultBranch, validateGitForkSyncExpectedUpstream } from '../shared/git-fork-sync'
import { InFlightPromiseDedupe, stableInFlightKey } from '../shared/in-flight-promise-dedupe'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../shared/git-fetch-auto-maintenance'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedRevParsePathFormatError
} from '../shared/git-worktree-command-capabilities'
import { GitResponseStreamRegistry } from './git-response-stream'
import { GIT_RESPONSE_STREAM_THRESHOLD } from './protocol'
import { endSubprocessStdin } from '../shared/subprocess-stdin-write'

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
  // Old git ignores `--path-format=absolute`, so a relative toplevel/git-dir
  // must be resolved against the scanned repo path. Mirror worktree.ts's
  // resolveRevParsePath: pick the win32/posix resolver from the repoPath shape.
  return isWindowsAbsolutePath(repoPath)
    ? path.win32.resolve(repoPath, value)
    : path.posix.resolve(repoPath, value)
}

type RelayRepoLocation = { topLevel: string; commonDir: string }

function parseRelayRepoLocation(repoPath: string, output: string): RelayRepoLocation | undefined {
  // Old git (pre `--path-format`) echoes the unrecognized flag to stdout and
  // exits 0 rather than erroring, so drop any echoed `-`-prefixed lines and
  // read the two trailing path lines (toplevel, then git-common-dir). Strip only
  // the trailing CR, not surrounding spaces — git paths may legitimately start
  // or end with a space.
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
  // Why: large diff/exec responses are chunked onto the bulk lane so they do
  // not head-of-line-block interactive pty.data echo on the shared SSH channel.
  private readonly responseStreams = new GitResponseStreamRegistry()

  // Why: configured submodule paths change rarely; an instance-level TTL cache
  // avoids re-reading `.gitmodules` on every diff click over SSH, and being
  // per-instance it stays bound to the connection lifecycle (no cross-test leak).
  private submodulePathsCache: SubmodulePathsCache = createSubmodulePathsCache()

  // Why: RelayContext is accepted for protocol back-compat (see
  // docs/relay-fs-allowlist-removal.md) but no longer consulted on git ops.
  constructor(dispatcher: RelayDispatcher, _context: RelayContext) {
    this.dispatcher = dispatcher
    this.registerHandlers()
    // Why: a detached client's git.responseAck frames will never arrive; wake
    // any pump parked on the ack window so it re-checks staleness and exits.
    this.dispatcher.onClientDetached?.(() => this.responseStreams.wakeAll())
  }

  dispose(): void {
    this.responseStreams.disposeAll()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('git.status', (p) => this.getStatus(p))
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

  // Why: when the client opted into response streaming and the serialized result
  // exceeds the threshold, chunk it onto the bulk lane and return a small
  // sentinel as the RPC result. Old clients omit the flag (single-frame, as
  // today); old relays never call this, so a new client falls back to the plain
  // result they return.
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

  private async runWithDiffDedupeClear<T>(run: () => Promise<T>): Promise<T> {
    // Why: git mutations can stale both existing and concurrently-started diff reads.
    // Clear before and after so later reads never join pre-mutation work.
    this.gitDiffReadDedupe.clear()
    try {
      return await run()
    } finally {
      this.gitDiffReadDedupe.clear()
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
    const env = buildRelayGitEnv()
    if (opts?.disableOptionalLocks) {
      env.GIT_OPTIONAL_LOCKS = '0'
    }
    if (opts?.nonInteractive) {
      env.GIT_TERMINAL_PROMPT = '0'
      env.GIT_ASKPASS = ''
      env.SSH_ASKPASS = ''
      env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes'
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

  private async getStatus(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
    return getStatusOp(this.git.bind(this), params)
  }

  // Why: the parent status only lists a single gitlink row per submodule. The
  // renderer fetches inner per-file changes on demand by running a plain status
  // inside the submodule's own worktree. Reject paths escaping the worktree to
  // match the diff handler's traversal guard.
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
    // Why: a moved gitlink (clean worktree) has no uncommitted rows; surface the
    // files changed between the recorded and checked-out commits so the expanded
    // submodule isn't empty. Mirrors getSubmoduleStatus in the local handler.
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
    // Why: filePath is relative to worktreePath and used in readWorkingFile via
    // path.join. Without validation, ../../etc/passwd traverses outside the worktree.
    const resolved = path.resolve(worktreePath, filePath)
    const rel = path.relative(path.resolve(worktreePath), resolved)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }
    const staged = params.staged as boolean
    const compareAgainstHead = params.compareAgainstHead as boolean | undefined
    // Why: register the in-flight dedupe synchronously (before any await) so
    // concurrent identical reads coalesce; submodule routing happens inside.
    const result = await this.gitDiffReadDedupe.run(
      stableInFlightKey(['diff', worktreePath, filePath, staged, compareAgainstHead]),
      async () => {
        // Why: gitlink paths can't be read as blobs and submodule working dirs
        // read as empty, so route the gitlink root → pointer diff and inner
        // files → recurse into the submodule's own worktree (mirrors local).
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
            // Why: a moved gitlink (clean worktree) keeps inner changes in
            // committed history, so diff the two commits; otherwise read the
            // working-tree blob.
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
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    try {
      await this.git(['add', '--', filePath], worktreePath)
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async commit(
    params: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    const message = params.message as string
    try {
      return await commitChangesRelay(this.git.bind(this), worktreePath, message)
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async unstage(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    try {
      await this.git(['restore', '--staged', '--', filePath], worktreePath)
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async bulkStage(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    try {
      for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
        const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
        await this.git(['add', '--', ...chunk], worktreePath)
      }
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async bulkUnstage(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    try {
      for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
        const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
        await this.git(['restore', '--staged', '--', ...chunk], worktreePath)
      }
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async abortMerge(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    try {
      await this.git(['merge', '--abort'], worktreePath)
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async abortRebase(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    try {
      await this.git(['rebase', '--abort'], worktreePath)
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async checkout(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    const branch = params.branch as string
    // Defense-in-depth: reject option-like branch tokens (the RPC schema also
    // validates, but this relay entrypoint is reachable independently). The
    // `startsWith('-')` guard is what prevents flag injection; the trailing `--`
    // marks that no pathspecs follow so the token is treated as a branch ref.
    if (typeof branch !== 'string' || branch.length === 0 || branch.startsWith('-')) {
      throw new Error('invalid_branch_name')
    }
    try {
      await this.git(['checkout', branch, '--'], worktreePath)
      return { ok: true as const, branch }
    } finally {
      this.gitDiffReadDedupe.clear()
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
    // Why: empty rel or '.' means the path IS the worktree root — rm -rf would
    // delete the entire worktree. Reject along with parent-escaping paths.
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
    this.gitDiffReadDedupe.clear()
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
      this.gitDiffReadDedupe.clear()
    }
  }

  private async bulkDiscard(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
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
        // Why: selecting a tracked directory can make `ls-files -z` return
        // enough descendants for push(...split) to exceed the argument limit.
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
      this.gitDiffReadDedupe.clear()
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
    // Why: a baseRef starting with '-' would be interpreted as a flag to
    // git rev-parse, potentially leaking environment variables or config.
    if (baseRef.startsWith('-')) {
      throw new Error('Base ref must not start with "-"')
    }
    const gitBound = this.git.bind(this)
    return branchCompareOp(gitBound, worktreePath, baseRef, async (mergeBase, headOid) => {
      // Why: -c core.quotePath=false keeps non-ASCII filenames as raw UTF-8;
      // without it parseBranchDiff would yield C-style octal-escaped paths.
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
      // Why: we only swallow the 'no upstream configured' error — that's an
      // expected state, not a failure. Other errors (auth, corruption, network)
      // should surface to the user so they can act on them.
      if (isNoUpstreamError(error)) {
        return { hasUpstream: false, ahead: 0, behind: 0 }
      }
      // Why: match fetch/push/pull normalization so execFile preamble and local
      // paths don't leak to the renderer.
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
      // Why: this only identifies stale post-rebase upstreams. If the probe
      // fails over SSH, keep the conservative pull-first sync path.
      return false
    }
  }

  private async fetch(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
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
        // Why: mirror the local gitFetch normalization so SSH users see the same
        // actionable messages instead of raw git stderr (which varies across
        // versions/locales and may embed credentials).
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async forkSync(params: Record<string, unknown>, context?: RequestContext) {
    return this.runWithDiffDedupeClear(async () => {
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
    this.gitDiffReadDedupe.clear()
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
        // Why: create-worktree needs a write-capable fetch, but generic git.exec
        // intentionally rejects fetch. This narrow RPC keeps the relay allowlist
        // tight while preserving the same safe error normalization as git.fetch.
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async fetchGitLabMergeRequestHead(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
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
        // Why: GitLab MR heads are not refs/heads/*, so the remote-tracking
        // fetch RPC cannot represent fork MRs. Keep this write path MR-only.
        await this.git(
          ['fetch', '--no-tags', remote, `refs/merge-requests/${mergeRequestIid}/head`],
          worktreePath
        )
      } catch (error) {
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async push(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    // Why: mirror src/main/git/remote.ts. Push to a configured upstream when
    // present so SSH worktrees with non-origin targets do not get repointed.
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
        // Why: mirror the local gitPush normalization so SSH users see the same
        // "non-fast-forward / pull first" guidance instead of raw git stderr.
        throw new Error(normalizeGitErrorMessage(error, 'push'))
      }
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async pullWithArgs(params: Record<string, unknown>, pullArgs: string[]) {
    this.gitDiffReadDedupe.clear()
    const worktreePath = params.worktreePath as string
    try {
      try {
        if (params.pushTarget !== undefined) {
          assertGitPushTargetShape(params.pushTarget)
          const pushTarget = params.pushTarget as GitPushTarget
          await this.git(['check-ref-format', '--branch', pushTarget.branchName], worktreePath)
          await this.git(
            ['pull', ...pullArgs, pushTarget.remoteName, pushTarget.branchName],
            worktreePath
          )
          return
        }
        const upstream = await resolveEffectiveGitUpstream((args) => this.git(args, worktreePath))
        if (upstream && !upstream.isConfiguredUpstream) {
          // Why: legacy Orca branches may still track origin/main while pushes
          // target origin/<branch>. Pull the same effective branch the UI reports.
          await this.git(
            ['pull', ...pullArgs, upstream.remoteName, upstream.branchName],
            worktreePath
          )
          return
        }
        await this.git(['pull', ...pullArgs], worktreePath)
      } catch (error) {
        // Why: mirror the local gitPull normalization so SSH users see the same
        // actionable messages instead of raw git stderr.
        throw new Error(normalizeGitErrorMessage(error, 'pull'))
      }
    } finally {
      this.gitDiffReadDedupe.clear()
    }
  }

  private async pull(params: Record<string, unknown>) {
    // Why: plain `git pull` honors the user's configured merge/rebase/ff policy.
    // If no policy exists, Git's policy error is normalized with setup guidance.
    await this.pullWithArgs(params, [])
  }

  private async fastForward(params: Record<string, unknown>) {
    await this.pullWithArgs(params, ['--ff-only'])
  }

  private async rebaseFromBase(params: Record<string, unknown>) {
    this.gitDiffReadDedupe.clear()
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
      this.gitDiffReadDedupe.clear()
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
    const { stdout, stderr } = await this.git(args, cwd, { signal: context?.signal })
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
    return await this.spawnClone(args, cwd, progressId, context)
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
        env: buildRelayGitEnv(),
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
    return this.runWithDiffDedupeClear(async () => {
      const worktreePath = params.worktreePath
      const newBranch = params.newBranch
      if (typeof worktreePath !== 'string' || typeof newBranch !== 'string') {
        throw new Error('Invalid branch rename request.')
      }
      if (newBranch.startsWith('-')) {
        throw new Error('Branch name must not start with "-".')
      }
      try {
        // Why: generic git.exec intentionally blocks destructive branch flags.
        // This narrow RPC permits only the already-checked current-branch rename.
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
    // Why: an empty repoPath would resolve `cwd` to the relay's own process
    // directory, running the destructive update-ref against the wrong repo. NUL
    // bytes cannot reach git safely either; reject both at the boundary.
    if (!repoPath || repoPath.includes('\0') || expectedHead.includes('\0')) {
      throw new Error('Invalid preserved branch force-delete request.')
    }
    return this.runWithDiffDedupeClear(() =>
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
            // Why: some old Git versions echo the unknown option and exit zero;
            // remember that signal even though the trailing paths remain usable.
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
    // Expand `~` so the early-return matches git's absolute porcelain path for
    // legacy SSH repos stored with a tilde, sparing them a rev-parse per poll.
    const resolvedRepoPath = expandTilde(repoPath)
    if (!mainPath || areRelayWorktreePathsEqual(mainPath, resolvedRepoPath)) {
      return worktrees
    }

    const location = await this.readRepoLocation(resolvedRepoPath)
    if (!location) {
      return worktrees
    }

    // Why: only a separate-git-dir/submodule main worktree reports the Git
    // directory as the main entry — i.e. the main entry equals git-common-dir.
    // A linked worktree's main entry is a real working root, so gating on this
    // equality avoids overwriting it with the linked worktree's own toplevel.
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
          // Why: `-z` keeps newline-containing SSH worktree paths intact, but
          // Git <2.36 requires the line-block parser.
          try {
            const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoPath, {
              signal: context?.signal
            })
            return this.normalizeMainWorktreePath(repoPath, parseWorktreeList(stdout))
          } catch {
            return []
          }
        },
        isUnsupportedWorktreeListZError
      )
      .catch(() => [])
  }

  private async addWorktree(params: Record<string, unknown>) {
    return this.runWithDiffDedupeClear(() => addWorktreeOp(this.git.bind(this), params))
  }

  private async removeWorktree(params: Record<string, unknown>) {
    return this.runWithDiffDedupeClear(() =>
      removeWorktreeOp(this.git.bind(this), params, this.gitCapabilities)
    )
  }

  private async worktreeIsClean(params: Record<string, unknown>) {
    return worktreeIsCleanOp(this.git.bind(this), params)
  }

  private async refreshLocalBaseRefForWorktreeCreate(params: Record<string, unknown>) {
    return this.runWithDiffDedupeClear(() =>
      refreshLocalBaseRefForWorktreeCreateOp(this.git.bind(this), params, this.gitCapabilities)
    )
  }
}
