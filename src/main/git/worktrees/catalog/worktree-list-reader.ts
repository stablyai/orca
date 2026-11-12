import { gitResultPathTranslator } from '../../command-runner/host-routing/wsl-path-translation'
import type { GitExecutionContext } from '../../command-runner/host-routing/wsl-git-path-preparation'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import { annotateWorktreeLocksFromAdmin } from '../../../../shared/git/worktrees/git-worktree-admin'
import { stat } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedRevParsePathFormatError,
  isUnsupportedWorktreeListZError
} from '../../../../shared/git/worktrees/git-worktree-command-capabilities'
import { withLocalGitCapabilityCacheForExecution } from '../../command-runner/host-routing/git-capability-state'
import { parseWorktreeList } from '../../../../shared/git/worktrees/git-worktree-porcelain-parser'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import {
  WORKTREE_LIST_TIMEOUT_MS,
  getErrorCode,
  gitExecOptions
} from '../worktree-operation-options'
import { areWorktreePathsEqual, resolveRevParsePath } from './worktree-path-comparison'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'

const PRUNABLE_EXISTENCE_PROBE_CONCURRENCY = 8

type RepoLocation = { topLevel: string; commonDir: string; gitDir: string }

function parseRepoLocation(
  repoPath: string,
  output: string,
  toHostPath: (path: string) => string
): RepoLocation | undefined {
  // Older Git echoes unknown flags with exit 0; keep the last three path lines and preserve edge spaces.
  const lines = output
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0 && !line.startsWith('-'))
  if (lines.length < 3) {
    return undefined
  }
  const [topLevel, commonDir, gitDir] = lines.slice(-3)
  return {
    topLevel: resolveRevParsePath(repoPath, toHostPath(topLevel)),
    commonDir: resolveRevParsePath(repoPath, toHostPath(commonDir)),
    gitDir: resolveRevParsePath(repoPath, toHostPath(gitDir))
  }
}

export async function readRepoLocation(
  repoPath: string,
  resolveBasePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<RepoLocation | undefined> {
  try {
    return await withLocalGitCapabilityCacheForExecution(
      { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
      (capabilities) =>
        capabilities.runWithFallback(
          'rev-parse-path-format',
          async () => {
            const result = await gitExecFileAsync(
              [
                'rev-parse',
                '--path-format=absolute',
                '--show-toplevel',
                '--git-common-dir',
                '--git-dir'
              ],
              gitExecOptions(repoPath, options)
            )
            if (hasUnsupportedRevParsePathFormatEcho(result.stdout)) {
              // Cache the unsupported-option signal even when parsing recovers.
              capabilities.rememberUnsupported('rev-parse-path-format')
            }
            return parseRepoLocation(
              resolveBasePath,
              result.stdout,
              await gitResultPathTranslator(result, repoPath, options)
            )
          },
          async () => {
            const result = await gitExecFileAsync(
              ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'],
              gitExecOptions(repoPath, options)
            )
            return parseRepoLocation(
              resolveBasePath,
              result.stdout,
              await gitResultPathTranslator(result, repoPath, options)
            )
          },
          isUnsupportedRevParsePathFormatError
        )
    )
  } catch {
    return undefined
  }
}

/** Bare repos reject --show-toplevel; resolve older Git's relative common dir in Git execution space. */
export async function readRepoCommonDirWithContext(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<{ path: string; executionContext?: GitExecutionContext } | undefined> {
  const readCommonDir = (stdout: string): string | undefined => {
    return stdout
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .findLast((line) => line.length > 0 && !line.startsWith('-'))
  }
  try {
    return await withLocalGitCapabilityCacheForExecution(
      { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
      (capabilities) =>
        capabilities.runWithFallback(
          'rev-parse-path-format',
          async () => {
            const result = await gitExecFileAsync(
              ['rev-parse', '--path-format=absolute', '--git-common-dir'],
              gitExecOptions(repoPath, options)
            )
            if (hasUnsupportedRevParsePathFormatEcho(result.stdout)) {
              capabilities.rememberUnsupported('rev-parse-path-format')
            }
            const path = readCommonDir(result.stdout)
            const toHostPath = await gitResultPathTranslator(result, repoPath, options)
            return path
              ? {
                  path: resolveRevParsePath(repoPath, toHostPath(path)),
                  executionContext: toHostPath.executionContext
                }
              : undefined
          },
          async () => {
            const result = await gitExecFileAsync(
              ['rev-parse', '--git-common-dir'],
              gitExecOptions(repoPath, options)
            )
            const path = readCommonDir(result.stdout)
            const toHostPath = await gitResultPathTranslator(result, repoPath, options)
            return path
              ? {
                  path: resolveRevParsePath(repoPath, toHostPath(path)),
                  executionContext: toHostPath.executionContext
                }
              : undefined
          },
          isUnsupportedRevParsePathFormatError
        )
    )
  } catch {
    return undefined
  }
}

export async function readRepoCommonDirFromGit(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<string | undefined> {
  return (await readRepoCommonDirWithContext(repoPath, options))?.path
}

/** Detached HEAD returns undefined. */
export async function readCheckedOutBranchRef(
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<string | undefined> {
  try {
    const result = await gitExecFileAsync(
      ['symbolic-ref', '--quiet', 'HEAD'],
      gitExecOptions(worktreePath, options)
    )
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export async function readWorktreeHeadOid(
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<string> {
  try {
    const result = await gitExecFileAsync(
      ['rev-parse', 'HEAD'],
      gitExecOptions(worktreePath, options)
    )
    return result.stdout.trim()
  } catch {
    return ''
  }
}

async function normalizeMainWorktreePath(
  repoPath: string,
  worktrees: GitWorktreeInfo[],
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const mainIndex = worktrees.findIndex((worktree) => worktree.isMainWorktree)
  const mainWorktree = worktrees[mainIndex]
  // Reader outputs already use host paths, like the repository identity.
  if (!mainWorktree || areWorktreePathsEqual(mainWorktree.path, repoPath)) {
    return worktrees
  }

  const location = await readRepoLocation(repoPath, repoPath, options)
  if (!location) {
    return worktrees
  }

  // Only separate-git-dir/submodule main rows need their common-dir path replaced with the toplevel.
  if (!areWorktreePathsEqual(mainWorktree.path, location.commonDir)) {
    return worktrees
  }
  // A linked caller's toplevel is its own folder; using it would duplicate the main row.
  if (!areWorktreePathsEqual(location.gitDir, location.commonDir)) {
    return worktrees
  }

  const normalized = [...worktrees]
  normalized[mainIndex] = { ...mainWorktree, path: location.topLevel }
  return normalized
}

export async function readWorktreeList(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const execOptions = {
    cwd: repoPath,
    ...options,
    timeout: options.timeout ?? WORKTREE_LIST_TIMEOUT_MS
  }
  return withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
    (capabilities) =>
      capabilities.runWithFallback(
        'worktree-list-z',
        async () => {
          const result = await gitExecFileAsync(
            ['worktree', 'list', '--porcelain', '-z'],
            execOptions
          )
          return normalizeMainWorktreePath(
            repoPath,
            await translateWorktreeRows(result, repoPath, options, true),
            options
          )
        },
        async () => {
          // Git <2.36 rejects -z, which preserves embedded newlines in paths.
          const result = await gitExecFileAsync(['worktree', 'list', '--porcelain'], execOptions)
          const normalized = await normalizeMainWorktreePath(
            repoPath,
            await translateWorktreeRows(result, repoPath, options, false),
            options
          )
          // Git <2.31 omits prunable fields; verify linked paths rather than trusting stale registrations.
          return annotatePrunableByExistence(
            await annotateWorktreeLocksFromAdmin(repoPath, normalized, options),
            repoPath,
            options
          )
        },
        isUnsupportedWorktreeListZError
      )
  )
}

async function annotatePrunableByExistence(
  worktrees: GitWorktreeInfo[],
  _repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function probeNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      throwIfSignalAborted(options.signal)
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      // Locked registrations are never prunable; missing main paths are handled at repo level.
      if (
        !worktree ||
        worktree.isMainWorktree ||
        worktree.isBare ||
        worktree.locked ||
        worktree.prunable
      ) {
        continue
      }
      try {
        await stat(worktree.path)
      } catch (err) {
        if (getErrorCode(err) === 'ENOENT') {
          annotated[index] = { ...worktree, prunable: true }
        }
      }
    }
  }

  const workerCount = Math.min(PRUNABLE_EXISTENCE_PROBE_CONCURRENCY, worktrees.length)
  await waitForPromiseWithSignal(
    Promise.all(Array.from({ length: workerCount }, () => probeNext())),
    options.signal
  )
  throwIfSignalAborted(options.signal)
  return annotated
}

export const readTranslatedWorktreeGraph = readWorktreeList

async function translateWorktreeRows(
  result: { stdout: string; executionContext?: GitExecutionContext },
  repoPath: string,
  options: GitWorktreeExecOptions,
  nulDelimited: boolean
): Promise<GitWorktreeInfo[]> {
  const toHostPath = await gitResultPathTranslator(result, repoPath, options)
  return parseWorktreeList(result.stdout, { nulDelimited }).map((row) => ({
    ...row,
    path: toHostPath(row.path)
  }))
}
