/* eslint-disable max-lines -- Why: this relay handler centralizes the git RPC
protocol surface so local and SSH git behavior stay in one dispatch table. */
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
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
import { commitCompare as commitCompareOp, commitDiffEntry } from './git-handler-commit-diff-ops'
import {
  commitChangesRelay,
  addWorktreeOp,
  removeWorktreeOp,
  worktreeIsCleanOp
} from './git-handler-worktree-ops'
import { refreshLocalBaseRefForWorktreeCreateOp } from './git-handler-local-base-ref-refresh'
import { checkIgnoredPathsOp, detectConflictOperation, getStatusOp } from './git-handler-status-ops'
import { resolveRelayPushTarget } from './git-handler-push-target'
import { normalizeGitErrorMessage, isNoUpstreamError } from '../shared/git-remote-error'
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
import { buildRelayCommandEnv } from './relay-command-env'
import {
  removeSafeUntrackedDiscardTarget,
  removeSafeUntrackedDiscardTargets
} from '../shared/git-discard-path-safety'
import { getGitCloneFailureMessage } from '../shared/git-clone-failure-message'
import { syncForkDefaultBranch, validateGitForkSyncExpectedUpstream } from '../shared/git-fork-sync'

const execFileAsync = promisify(execFile)
const MAX_GIT_BUFFER = 10 * 1024 * 1024
const BULK_CHUNK_SIZE = 100

export class GitHandler {
  private dispatcher: RelayDispatcher

  // Why: RelayContext is accepted for protocol back-compat (see
  // docs/relay-fs-allowlist-removal.md) but no longer consulted on git ops.
  constructor(dispatcher: RelayDispatcher, _context: RelayContext) {
    this.dispatcher = dispatcher
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('git.status', (p) => this.getStatus(p))
    this.dispatcher.onRequest('git.checkIgnored', (p) => this.checkIgnored(p))
    this.dispatcher.onRequest('git.history', (p) => this.history(p))
    this.dispatcher.onRequest('git.commit', (p) => this.commit(p))
    this.dispatcher.onRequest('git.diff', (p) => this.getDiff(p))
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
    this.dispatcher.onRequest('git.push', (p) => this.push(p))
    this.dispatcher.onRequest('git.pull', (p) => this.pull(p))
    this.dispatcher.onRequest('git.fastForward', (p) => this.fastForward(p))
    this.dispatcher.onRequest('git.rebaseFromBase', (p) => this.rebaseFromBase(p))
    this.dispatcher.onRequest('git.branchDiff', (p) => this.branchDiff(p))
    this.dispatcher.onRequest('git.commitDiff', (p) => this.commitDiff(p))
    this.dispatcher.onRequest('git.listWorktrees', (p) => this.listWorktrees(p))
    this.dispatcher.onRequest('git.addWorktree', (p) => this.addWorktree(p))
    this.dispatcher.onRequest('git.removeWorktree', (p) => this.removeWorktree(p))
    this.dispatcher.onRequest('git.worktreeIsClean', (p) => this.worktreeIsClean(p))
    this.dispatcher.onRequest('git.refreshLocalBaseRefForWorktreeCreate', (p) =>
      this.refreshLocalBaseRefForWorktreeCreate(p)
    )
    this.dispatcher.onRequest('git.renameCurrentBranch', (p) => this.renameCurrentBranch(p))
    this.dispatcher.onRequest('git.exec', (p, context) => this.exec(p, context))
    this.dispatcher.onRequest('git.clone', (p, context) => this.clone(p, context))
    this.dispatcher.onRequest('git.isGitRepo', (p) => this.isGitRepo(p))
  }

  private async git(
    args: string[],
    cwd: string,
    opts?: {
      maxBuffer?: number
      disableOptionalLocks?: boolean
      signal?: AbortSignal
      nonInteractive?: boolean
    }
  ): Promise<{ stdout: string; stderr: string }> {
    const env = buildRelayCommandEnv()
    if (opts?.disableOptionalLocks) {
      env.GIT_OPTIONAL_LOCKS = '0'
    }
    if (opts?.nonInteractive) {
      env.GIT_TERMINAL_PROMPT = '0'
      env.GIT_ASKPASS = ''
      env.SSH_ASKPASS = ''
      env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes'
    }
    return execFileAsync('git', args, {
      cwd: expandTilde(cwd),
      env,
      encoding: 'utf-8',
      maxBuffer: opts?.maxBuffer ?? MAX_GIT_BUFFER,
      signal: opts?.signal
    })
  }

  private async gitBuffer(args: string[], cwd: string): Promise<Buffer> {
    const { stdout } = (await execFileAsync('git', args, {
      cwd,
      env: buildRelayCommandEnv(),
      encoding: 'buffer',
      maxBuffer: MAX_GIT_BUFFER
    })) as { stdout: Buffer }
    return stdout
  }

  private async getStatus(params: Record<string, unknown>) {
    return getStatusOp(this.git.bind(this), params)
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

  private async getDiff(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    // Why: filePath is relative to worktreePath and used in readWorkingFile via
    // path.join. Without validation, ../../etc/passwd traverses outside the worktree.
    const resolved = path.resolve(worktreePath, filePath)
    const rel = path.relative(path.resolve(worktreePath), resolved)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }
    return computeDiff(
      this.gitBuffer.bind(this),
      worktreePath,
      filePath,
      params.staged as boolean,
      params.compareAgainstHead as boolean | undefined
    )
  }

  private async stage(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    await this.git(['add', '--', filePath], worktreePath)
  }

  private async commit(
    params: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    const worktreePath = params.worktreePath as string
    const message = params.message as string
    return commitChangesRelay(this.git.bind(this), worktreePath, message)
  }

  private async unstage(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    await this.git(['restore', '--staged', '--', filePath], worktreePath)
  }

  private async bulkStage(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
      await this.git(['add', '--', ...chunk], worktreePath)
    }
  }

  private async bulkUnstage(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
      await this.git(['restore', '--staged', '--', ...chunk], worktreePath)
    }
  }

  private async abortMerge(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    await this.git(['merge', '--abort'], worktreePath)
  }

  private async abortRebase(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    await this.git(['rebase', '--abort'], worktreePath)
  }

  private async checkout(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const branch = params.branch as string
    // Defense-in-depth: reject option-like branch tokens (the RPC schema also
    // validates, but this relay entrypoint is reachable independently). The
    // `startsWith('-')` guard is what prevents flag injection; the trailing `--`
    // marks that no pathspecs follow so the token is treated as a branch ref.
    if (typeof branch !== 'string' || branch.length === 0 || branch.startsWith('-')) {
      throw new Error('invalid_branch_name')
    }
    await this.git(['checkout', branch, '--'], worktreePath)
    return { ok: true as const, branch }
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
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string

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
  }

  private async bulkDiscard(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    if (filePaths.length === 0) {
      return
    }

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
    const worktreePath = params.worktreePath as string
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
  }

  private async forkSync(params: Record<string, unknown>, context?: RequestContext) {
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
  }

  private async fetchRemoteTrackingRef(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const remote = params.remote
    const branch = params.branch
    const ref = params.ref
    if (typeof remote !== 'string' || typeof branch !== 'string' || typeof ref !== 'string') {
      throw new Error('Invalid remote-tracking fetch request.')
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
      await this.git(['fetch', '--no-tags', remote, `+refs/heads/${branch}:${ref}`], worktreePath)
    } catch (error) {
      // Why: create-worktree needs a write-capable fetch, but generic git.exec
      // intentionally rejects fetch. This narrow RPC keeps the relay allowlist
      // tight while preserving the same safe error normalization as git.fetch.
      throw new Error(normalizeGitErrorMessage(error, 'fetch'))
    }
  }

  private async push(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    // Why: mirror src/main/git/remote.ts. Push to a configured upstream when
    // present so SSH worktrees with non-origin targets do not get repointed.
    void params.publish
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
  }

  private async pullWithArgs(params: Record<string, unknown>, pullArgs: string[]) {
    const worktreePath = params.worktreePath as string
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
  }

  private async pull(params: Record<string, unknown>) {
    // Why: plain `git pull` uses the user's configured pull strategy (merge by
    // default) so diverged branches reconcile instead of erroring out.
    await this.pullWithArgs(params, [])
  }

  private async fastForward(params: Record<string, unknown>) {
    await this.pullWithArgs(params, ['--ff-only'])
  }

  private async rebaseFromBase(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    try {
      const source = await resolveGitRemoteRebaseSource(
        ((args) => this.git(args, worktreePath)) as GitCommandRunner,
        baseRef
      )
      await this.git(['pull', '--rebase', source.remoteName, source.branchName], worktreePath)
    } catch (error) {
      throw new Error(normalizeGitErrorMessage(error, 'pull'))
    }
  }

  private async branchDiff(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    if (baseRef.startsWith('-')) {
      throw new Error('Base ref must not start with "-"')
    }
    return branchDiffEntries(
      this.git.bind(this),
      this.gitBuffer.bind(this),
      worktreePath,
      baseRef,
      {
        includePatch: params.includePatch as boolean | undefined,
        filePath: params.filePath as string | undefined,
        oldPath: params.oldPath as string | undefined
      }
    )
  }

  private async commitDiff(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    return commitDiffEntry(this.gitBuffer.bind(this), worktreePath, {
      commitOid: params.commitOid as string,
      parentOid: params.parentOid as string | null | undefined,
      filePath: params.filePath as string,
      oldPath: params.oldPath as string | undefined
    })
  }

  private async exec(params: Record<string, unknown>, context?: RequestContext) {
    const args = params.args as string[]
    const cwd = params.cwd as string

    validateGitExecArgs(args)
    const { stdout, stderr } = await this.git(args, cwd, { signal: context?.signal })
    return { stdout, stderr }
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
        env: buildRelayCommandEnv(),
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
              percent: parseInt(match[2], 10)
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

  private async listWorktrees(params: Record<string, unknown>) {
    const repoPath = params.repoPath as string
    try {
      const { stdout } = await this.git(['worktree', 'list', '--porcelain', '-z'], repoPath)
      return parseWorktreeList(stdout, { nulDelimited: true })
    } catch (error) {
      if (!isUnsupportedWorktreeListZError(error)) {
        return []
      }
    }

    // Why: `-z` keeps newline-containing SSH worktree paths intact, but older
    // Git rejects it. Fall back to the original line-block parser there.
    try {
      const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoPath)
      return parseWorktreeList(stdout)
    } catch {
      return []
    }
  }

  private async addWorktree(params: Record<string, unknown>) {
    return addWorktreeOp(this.git.bind(this), params)
  }

  private async removeWorktree(params: Record<string, unknown>) {
    return removeWorktreeOp(this.git.bind(this), params)
  }

  private async worktreeIsClean(params: Record<string, unknown>) {
    return worktreeIsCleanOp(this.git.bind(this), params)
  }

  private async refreshLocalBaseRefForWorktreeCreate(params: Record<string, unknown>) {
    return refreshLocalBaseRefForWorktreeCreateOp(this.git.bind(this), params)
  }
}
