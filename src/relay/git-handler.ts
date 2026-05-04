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

const execFileAsync = promisify(execFile)
const MAX_GIT_BUFFER = 10 * 1024 * 1024
const BULK_CHUNK_SIZE = 100

export class GitHandler {
  private dispatcher: RelayDispatcher
  private context: RelayContext

  constructor(dispatcher: RelayDispatcher, context: RelayContext) {
    this.dispatcher = dispatcher
    this.context = context
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
    return getStatusOp(this.git.bind(this), this.context.validatePath.bind(this.context), params)
  }

  private async getDiff(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
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
    this.context.validatePath(worktreePath)
    const filePath = params.filePath as string
    await this.git(['add', '--', filePath], worktreePath)
  }

  private async commit(
    params: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    const message = params.message as string
    return commitChangesRelay(this.git.bind(this), worktreePath, message)
  }

  private async unstage(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    const filePath = params.filePath as string
    await this.git(['restore', '--staged', '--', filePath], worktreePath)
  }

  private async bulkStage(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    const filePaths = params.filePaths as string[]
    for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
      await this.git(['add', '--', ...chunk], worktreePath)
    }
  }

  private async bulkUnstage(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    const filePaths = params.filePaths as string[]
    for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
      await this.git(['restore', '--staged', '--', ...chunk], worktreePath)
    }
  }

  private async discard(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
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

    if (tracked) {
      await this.git(['restore', '--worktree', '--source=HEAD', '--', filePath], worktreePath)
    } else {
      // Why: textual path checks pass for symlinks inside the worktree, but
      // rm follows symlinks — so a symlink pointing outside the workspace
      // would delete the target. validatePathResolved catches this.
      await this.context.validatePathResolved(resolved)
      await rm(resolved, { force: true, recursive: true })
    }
  }

  private async conflictOperation(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    return detectConflictOperation(worktreePath)
  }

  private async branchCompare(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    const baseRef = params.baseRef as string
    // Why: a baseRef starting with '-' would be interpreted as a flag to
    // git rev-parse, potentially leaking environment variables or config.
    if (baseRef.startsWith('-')) {
      throw new Error('Base ref must not start with "-"')
    }
    const gitBound = this.git.bind(this)
    return branchCompareOp(gitBound, worktreePath, baseRef, async (mergeBase, headOid) => {
      const { stdout } = await gitBound(
        ['diff', '--name-status', '-M', '-C', mergeBase, headOid],
        worktreePath
      )
      return parseBranchDiff(stdout)
    })
  }

  private async branchDiff(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
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
    this.context.validatePath(cwd)

    validateGitExecArgs(args)
    const { stdout, stderr } = await this.git(args, cwd)
    return { stdout, stderr }
  }

  // Why: isGitRepo is called during the add-repo flow before any workspace
  // roots are registered with the relay. Skipping validatePath is safe because
  // this is a read-only git rev-parse check — no files are mutated.
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
    this.context.validatePath(repoPath)
    try {
      const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoPath)
      return parseWorktreeList(stdout)
    } catch {
      return []
    }
  }

  private async addWorktree(params: Record<string, unknown>) {
    return addWorktreeOp(this.git.bind(this), this.context.validatePath.bind(this.context), params)
  }

  private async removeWorktree(params: Record<string, unknown>) {
    return removeWorktreeOp(
      this.git.bind(this),
      this.context.validatePath.bind(this.context),
      params
    )
  }
}
