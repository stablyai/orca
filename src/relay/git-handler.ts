import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import * as path from 'path'
import type { RelayDispatcher } from './dispatcher'
import type { RelayContext } from './context'
import { expandTilde } from './context'
import {
  parseStatusOutput,
  parseUnmergedEntry,
  parseBranchDiff,
  parseWorktreeList
} from './git-handler-utils'
import {
  computeDiff,
  branchCompare as branchCompareOp,
  branchDiffEntries,
  validateGitExecArgs
} from './git-handler-ops'

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
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    const conflictOperation = await this.detectConflictOperation(worktreePath)
    const entries: Record<string, unknown>[] = []

    try {
      const { stdout } = await this.git(
        ['status', '--porcelain=v2', '--untracked-files=all'],
        worktreePath
      )

      const parsed = parseStatusOutput(stdout)
      entries.push(...parsed.entries)

      for (const uLine of parsed.unmergedLines) {
        const entry = parseUnmergedEntry(worktreePath, uLine)
        if (entry) {
          entries.push(entry)
        }
      }
    } catch {
      // Not a git repo or git not available
    }

    return { entries, conflictOperation }
  }

  private async detectConflictOperation(worktreePath: string): Promise<string> {
    const gitDir = await this.resolveGitDir(worktreePath)
    try {
      if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
        return 'merge'
      }
      if (
        existsSync(path.join(gitDir, 'rebase-merge')) ||
        existsSync(path.join(gitDir, 'rebase-apply'))
      ) {
        return 'rebase'
      }
      if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
        return 'cherry-pick'
      }
    } catch {
      // fs error
    }
    return 'unknown'
  }

  private async resolveGitDir(worktreePath: string): Promise<string> {
    const dotGitPath = path.join(worktreePath, '.git')
    try {
      const contents = await readFile(dotGitPath, 'utf-8')
      const match = contents.match(/^gitdir:\s*(.+)\s*$/m)
      if (match) {
        return path.resolve(worktreePath, match[1])
      }
    } catch {
      // .git is a directory
    }
    return dotGitPath
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
    const staged = params.staged as boolean
    return computeDiff(this.gitBuffer.bind(this), worktreePath, filePath, staged)
  }

  private async stage(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    const filePath = params.filePath as string
    await this.git(['add', '--', filePath], worktreePath)
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
    return this.detectConflictOperation(worktreePath)
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
    const repoPath = params.repoPath as string
    this.context.validatePath(repoPath)
    const branchName = params.branchName as string
    const targetDir = params.targetDir as string
    this.context.validatePath(targetDir)
    const base = params.base as string | undefined
    const track = params.track as boolean | undefined

    // Why: a branchName starting with '-' would be interpreted as a git flag,
    // potentially changing the command's semantics (e.g. "--detach").
    if (branchName.startsWith('-') || (base && base.startsWith('-'))) {
      throw new Error('Branch name and base ref must not start with "-"')
    }

    const args = ['worktree', 'add']
    if (track) {
      args.push('--track')
    }
    args.push('-b', branchName, targetDir)
    if (base) {
      args.push(base)
    }

    await this.git(args, repoPath)
  }

  private async removeWorktree(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    this.context.validatePath(worktreePath)
    const force = params.force as boolean | undefined

    let repoPath = worktreePath
    try {
      const { stdout } = await this.git(['rev-parse', '--git-common-dir'], worktreePath)
      const commonDir = stdout.trim()
      if (commonDir && commonDir !== '.git') {
        repoPath = path.resolve(worktreePath, commonDir, '..')
      }
    } catch {
      // Fall through with worktreePath as repo
    }

    const args = ['worktree', 'remove']
    if (force) {
      args.push('--force')
    }
    args.push(worktreePath)
    await this.git(args, repoPath)
    await this.git(['worktree', 'prune'], repoPath)
  }
}
