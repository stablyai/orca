import { execFile } from 'child_process'
import { promisify } from 'util'
import { rm } from 'fs/promises'
import * as path from 'path'
import type { RelayDispatcher } from './dispatcher'
import type { RelayContext } from './context'
import { expandTilde } from './context'
import { parseBranchDiff, parseWorktreeList } from './git-handler-utils'
import {
  computeDiff,
  branchCompare as branchCompareOp,
  branchDiffEntries,
  validateGitExecArgs
} from './git-handler-ops'
import { commitChangesRelay, addWorktreeOp, removeWorktreeOp } from './git-handler-worktree-ops'
import { detectConflictOperation, getStatusOp } from './git-handler-status-ops'
import { normalizeGitErrorMessage, isNoUpstreamError } from '../shared/git-remote-error'

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
    this.dispatcher.onRequest('git.commit', (p) => this.commit(p))
    this.dispatcher.onRequest('git.diff', (p) => this.getDiff(p))
    this.dispatcher.onRequest('git.stage', (p) => this.stage(p))
    this.dispatcher.onRequest('git.unstage', (p) => this.unstage(p))
    this.dispatcher.onRequest('git.bulkStage', (p) => this.bulkStage(p))
    this.dispatcher.onRequest('git.bulkUnstage', (p) => this.bulkUnstage(p))
    this.dispatcher.onRequest('git.discard', (p) => this.discard(p))
    this.dispatcher.onRequest('git.conflictOperation', (p) => this.conflictOperation(p))
    this.dispatcher.onRequest('git.branchCompare', (p) => this.branchCompare(p))
    this.dispatcher.onRequest('git.upstreamStatus', (p) => this.upstreamStatus(p))
    this.dispatcher.onRequest('git.fetch', (p) => this.fetch(p))
    this.dispatcher.onRequest('git.push', (p) => this.push(p))
    this.dispatcher.onRequest('git.pull', (p) => this.pull(p))
    this.dispatcher.onRequest('git.branchDiff', (p) => this.branchDiff(p))
    this.dispatcher.onRequest('git.listWorktrees', (p) => this.listWorktrees(p))
    this.dispatcher.onRequest('git.addWorktree', (p) => this.addWorktree(p))
    this.dispatcher.onRequest('git.removeWorktree', (p) => this.removeWorktree(p))
    this.dispatcher.onRequest('git.exec', (p) => this.exec(p))
    this.dispatcher.onRequest('git.isGitRepo', (p) => this.isGitRepo(p))
  }

  private async git(
    args: string[],
    cwd: string,
    opts?: { maxBuffer?: number }
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, {
      cwd: expandTilde(cwd),
      encoding: 'utf-8',
      maxBuffer: opts?.maxBuffer ?? MAX_GIT_BUFFER
    })
  }

  private async gitBuffer(args: string[], cwd: string): Promise<Buffer> {
    const { stdout } = (await execFileAsync('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: MAX_GIT_BUFFER
    })) as { stdout: Buffer }
    return stdout
  }

  private async getStatus(params: Record<string, unknown>) {
    return getStatusOp(this.git.bind(this), params)
  }

  private async getDiff(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    // Why: filePath is relative to worktreePath and used in readWorkingFile via
    // path.join. Without validation, ../../etc/passwd traverses outside the worktree.
    const resolved = path.resolve(worktreePath, filePath)
    const rel = path.relative(path.resolve(worktreePath), resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
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

  private async discard(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string

    const resolved = path.resolve(worktreePath, filePath)
    const rel = path.relative(path.resolve(worktreePath), resolved)
    // Why: empty rel or '.' means the path IS the worktree root — rm -rf would
    // delete the entire worktree. Reject along with parent-escaping paths.
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }

    let tracked = false
    try {
      await this.git(['ls-files', '--error-unmatch', '--', filePath], worktreePath)
      tracked = true
    } catch {
      // untracked
    }

    await (tracked
      ? this.git(['restore', '--worktree', '--source=HEAD', '--', filePath], worktreePath)
      : rm(resolved, { force: true, recursive: true }))
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
      return parseBranchDiff(stdout)
    })
  }

  private async upstreamStatus(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string

    try {
      const { stdout: upstreamStdout } = await this.git(
        ['rev-parse', '--abbrev-ref', 'HEAD@{u}'],
        worktreePath
      )
      const upstreamName = upstreamStdout.trim()
      if (!upstreamName) {
        return { hasUpstream: false, ahead: 0, behind: 0 }
      }
      const { stdout: countsStdout } = await this.git(
        ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
        worktreePath
      )
      const tokens = countsStdout.trim().split(/\s+/)
      if (tokens.length !== 2) {
        // Why: 'rev-list --left-right --count HEAD...@{u}' must emit exactly two
        // tokens; anything else (empty stdout, SSH transport truncation, unexpected
        // locale) is a real failure and must not be silently reported as "in sync" 0/0.
        throw new Error(`Unexpected git rev-list output: ${JSON.stringify(countsStdout)}`)
      }
      const ahead = Number.parseInt(tokens[0]!, 10)
      const behind = Number.parseInt(tokens[1]!, 10)
      if (!Number.isFinite(ahead) || !Number.isFinite(behind) || ahead < 0 || behind < 0) {
        throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(countsStdout)}`)
      }
      return {
        hasUpstream: true,
        upstreamName,
        ahead,
        behind
      }
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

  private async fetch(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    try {
      await this.git(['fetch', '--prune'], worktreePath)
    } catch (error) {
      // Why: mirror the local gitFetch normalization so SSH users see the same
      // actionable messages instead of raw git stderr (which varies across
      // versions/locales and may embed credentials).
      throw new Error(normalizeGitErrorMessage(error, 'fetch'))
    }
  }

  private async push(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    // Why: always pass --set-upstream (mirrors src/main/git/remote.ts).
    // Orca's worktrees initially track the BASE ref (origin/main) because
    // they're created via `git worktree add --track -b <name> <dir>
    // <baseRef>` — without --set-upstream the local branch keeps tracking
    // the base after the first push, so ahead/behind via @{u} measures
    // "ahead of base" instead of "ahead of remote branch", and the UI's
    // primary button never rotates from "Push" to "Commit". The `publish`
    // flag is preserved in the param shape for IPC compatibility but is no
    // longer load-bearing. On an already-published branch --set-upstream is
    // a no-op for the tracking config.
    void params.publish
    try {
      await this.git(['push', '--set-upstream', 'origin', 'HEAD'], worktreePath)
    } catch (error) {
      // Why: mirror the local gitPush normalization so SSH users see the same
      // "non-fast-forward / pull first" guidance instead of raw git stderr.
      throw new Error(normalizeGitErrorMessage(error, 'push'))
    }
  }

  private async pull(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    // Why: plain `git pull` uses the user's configured pull strategy (merge by
    // default) so diverged branches reconcile instead of erroring out.
    try {
      await this.git(['pull'], worktreePath)
    } catch (error) {
      // Why: mirror the local gitPull normalization so SSH users see the same
      // actionable messages instead of raw git stderr.
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

  private async exec(params: Record<string, unknown>) {
    const args = params.args as string[]
    const cwd = params.cwd as string

    validateGitExecArgs(args)
    const { stdout, stderr } = await this.git(args, cwd)
    return { stdout, stderr }
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
}
