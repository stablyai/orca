import * as path from 'node:path'
import type { RequestContext } from './dispatcher'
import { expandTilde } from './context'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { isUnsupportedWorktreeListZError } from './git-handler-utils'
import { parseWorktreeList } from '../shared/git-worktree-porcelain-parser'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import {
  addWorktreeOp,
  areRelayWorktreePathsEqual,
  removeWorktreeOp,
  worktreeIsCleanOp
} from './git-handler-worktree-ops'
import { annotatePrunableWorktreesByExistence } from './git-handler-worktree-list'
import { refreshLocalBaseRefForWorktreeCreateOp } from './git-handler-local-base-ref-refresh'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedRevParsePathFormatError
} from '../shared/git-worktree-command-capabilities'

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function resolveRelayPath(repoPath: string, value: string): string {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value
  }
  // Old Git ignores `--path-format=absolute`; resolve relative paths against repoPath by path shape.
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

export class GitHandlerWorktreeOperations extends GitHandlerOperationContext {
  async isGitRepo(params: Record<string, unknown>) {
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
    worktrees: GitWorktreeInfo[]
  ): Promise<GitWorktreeInfo[]> {
    const mainIndex = worktrees.findIndex((worktree) => worktree.isMainWorktree === true)
    const mainWorktree = worktrees[mainIndex]
    const mainPath = mainWorktree?.path ?? ''
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

  async listWorktrees(params: Record<string, unknown>, context?: RequestContext) {
    const repoPath = params.repoPath as string
    return this.gitCapabilities.runWithFallback(
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
        // Why no catch (#14004): swallowing to `[]` would report an unreadable catalog as an authoritative
        // empty one, and callers use that to authorize missing-worktree teardown. Let the failure propagate.
        const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoPath, {
          signal: context?.signal
        })
        const normalized = await this.normalizeMainWorktreePath(repoPath, parseWorktreeList(stdout))
        // Why: Git <2.31 emits no `prunable` annotation, so probe each linked worktree's existence instead of trusting stale registrations (issue #8389).
        return annotatePrunableWorktreesByExistence(normalized)
      },
      isUnsupportedWorktreeListZError
    )
  }

  async addWorktree(params: Record<string, unknown>) {
    return this.runWithGitReadCacheClear(() => addWorktreeOp(this.git.bind(this), params))
  }

  async removeWorktree(params: Record<string, unknown>) {
    const remove = () =>
      this.runWithGitReadCacheClear(() =>
        removeWorktreeOp(this.git.bind(this), params, this.gitCapabilities)
      )
    const worktreePath = params.worktreePath
    return this.watcherRegistry && typeof worktreePath === 'string'
      ? this.watcherRegistry.runWithRemovalFence(expandTilde(worktreePath), remove)
      : remove()
  }

  async worktreeIsClean(params: Record<string, unknown>) {
    return worktreeIsCleanOp(this.git.bind(this), params)
  }

  async refreshLocalBaseRefForWorktreeCreate(params: Record<string, unknown>) {
    return this.runWithGitReadCacheClear(() =>
      refreshLocalBaseRefForWorktreeCreateOp(this.git.bind(this), params, this.gitCapabilities)
    )
  }
}
