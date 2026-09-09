import { stat } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { toWslExecutionSpace } from '../../shared/wsl-paths'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedRevParsePathFormatError,
  isUnsupportedWorktreeListZError
} from '../../shared/git-worktree-command-capabilities'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import {
  WORKTREE_LIST_TIMEOUT_MS,
  getErrorCode,
  gitExecOptions
} from './worktree-operation-options'
import {
  areWorktreePathsEqual,
  resolveRevParsePath,
  translateWorktreePath
} from './worktree-path-comparison'
import { gitExecFileAsync } from './runner'

const PRUNABLE_EXISTENCE_PROBE_CONCURRENCY = 8

type RepoLocation = { topLevel: string; commonDir: string }

function parseRepoLocation(repoPath: string, output: string): RepoLocation | undefined {
  // Old git echoes the unrecognized `--path-format` flag and exits 0, so drop `-`-prefixed lines and
  // read the last two path lines (toplevel, git-common-dir); strip only trailing CR — paths may have edge spaces.
  const lines = output
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0 && !line.startsWith('-'))
  if (lines.length < 2) {
    return undefined
  }
  const [topLevel, commonDir] = lines.slice(-2)
  return {
    topLevel: resolveRevParsePath(repoPath, topLevel),
    commonDir: resolveRevParsePath(repoPath, commonDir)
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
            const { stdout } = await gitExecFileAsync(
              ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
              gitExecOptions(repoPath, options)
            )
            if (hasUnsupportedRevParsePathFormatEcho(stdout)) {
              // Why: some old Git echoes the unknown option and exits zero; remember that compat signal even though parsing recovers.
              capabilities.rememberUnsupported('rev-parse-path-format')
            }
            return parseRepoLocation(resolveBasePath, stdout)
          },
          async () => {
            const { stdout } = await gitExecFileAsync(
              ['rev-parse', '--show-toplevel', '--git-common-dir'],
              gitExecOptions(repoPath, options)
            )
            return parseRepoLocation(resolveBasePath, stdout)
          },
          isUnsupportedRevParsePathFormatError
        )
    )
  } catch {
    return undefined
  }
}

/**
 * The repo's common dir as Git reports it.
 *
 * Why `--git-common-dir` alone: adding `--show-toplevel` makes rev-parse fail outright on a bare repo.
 * Why the Git-space base: Git < 2.31 (the 2.25 baseline) ignores `--path-format=absolute` and prints a
 * relative `.git` at a main worktree root; resolving that against a UNC repoPath would compare a
 * Windows path against the worktree-side Linux answer, leaving the create's recovery inert (#16520).
 */
export async function readRepoCommonDirFromGit(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<string | undefined> {
  const resolveBasePath = toWslExecutionSpace(repoPath)
  const readCommonDir = (stdout: string): string | undefined => {
    const commonDir = stdout
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .findLast((line) => line.length > 0 && !line.startsWith('-'))
    return commonDir ? resolveRevParsePath(resolveBasePath, commonDir) : undefined
  }
  try {
    return await withLocalGitCapabilityCacheForExecution(
      { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
      (capabilities) =>
        capabilities.runWithFallback(
          'rev-parse-path-format',
          async () => {
            const { stdout } = await gitExecFileAsync(
              ['rev-parse', '--path-format=absolute', '--git-common-dir'],
              gitExecOptions(repoPath, options)
            )
            if (hasUnsupportedRevParsePathFormatEcho(stdout)) {
              capabilities.rememberUnsupported('rev-parse-path-format')
            }
            return readCommonDir(stdout)
          },
          async () => {
            const { stdout } = await gitExecFileAsync(
              ['rev-parse', '--git-common-dir'],
              gitExecOptions(repoPath, options)
            )
            return readCommonDir(stdout)
          },
          isUnsupportedRevParsePathFormatError
        )
    )
  } catch {
    return undefined
  }
}

/** The branch ref checked out in `worktreePath`, or undefined when HEAD is detached. */
export async function readCheckedOutBranchRef(
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<string | undefined> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['symbolic-ref', '--quiet', 'HEAD'],
      gitExecOptions(worktreePath, options)
    )
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export async function readWorktreeHeadOid(
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', 'HEAD'],
      gitExecOptions(worktreePath, options)
    )
    return stdout.trim()
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
  // Why: under WSL, porcelain/rev-parse paths are Linux but repoPath is UNC; compare in Git-output
  // space so the early-return matches and we skip a needless rev-parse per poll (runner still gets repoPath).
  const comparablePath = toWslExecutionSpace(repoPath)
  if (!mainWorktree || areWorktreePathsEqual(mainWorktree.path, comparablePath)) {
    return worktrees
  }

  const location = await readRepoLocation(repoPath, comparablePath, options)
  if (!location) {
    return worktrees
  }

  // Why: only a separate-git-dir/submodule main worktree reports git-common-dir as its path; gate on
  // that equality so we don't overwrite a linked worktree's real working root with its own toplevel.
  if (!areWorktreePathsEqual(mainWorktree.path, location.commonDir)) {
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
          const { stdout } = await gitExecFileAsync(
            ['worktree', 'list', '--porcelain', '-z'],
            execOptions
          )
          return normalizeMainWorktreePath(
            repoPath,
            parseWorktreeList(stdout, { nulDelimited: true }),
            options
          )
        },
        async () => {
          // Why: `-z` preserves worktree paths with newlines but Git <2.36 rejects it; fall back to the line parser.
          const { stdout } = await gitExecFileAsync(
            ['worktree', 'list', '--porcelain'],
            execOptions
          )
          const normalized = await normalizeMainWorktreePath(
            repoPath,
            parseWorktreeList(stdout),
            options
          )
          // Why: Git <2.31 emits no `prunable`, so probe each linked path for existence instead of trusting
          // stale registrations; a harmless backstop on 2.31–2.35 where parseWorktreeList already set it (#8389).
          return annotatePrunableByExistence(normalized, repoPath, options)
        },
        isUnsupportedWorktreeListZError
      )
  )
}

async function annotatePrunableByExistence(
  worktrees: GitWorktreeInfo[],
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function probeNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      // Git only prunes linked worktrees, never locked ones (a lock shields a missing dir; `locked`
      // parses only on Git >=2.31). A missing main worktree is handled by the repo-level ENOENT paths.
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
        await stat(translateWorktreePath(worktree.path, repoPath, options))
      } catch (err) {
        if (getErrorCode(err) === 'ENOENT') {
          annotated[index] = { ...worktree, prunable: true }
        }
      }
    }
  }

  const workerCount = Math.min(PRUNABLE_EXISTENCE_PROBE_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => probeNext()))
  return annotated
}

export async function readTranslatedWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  return (await readWorktreeList(repoPath, options)).map((worktree) => {
    const translatedPath = translateWorktreePath(worktree.path, repoPath, options)
    return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
  })
}
