import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { resolveGitMetadataPath } from '../../shared/git-metadata-path'
import { parseGitdirMarkerPayload } from '../../shared/gitdir-marker-payload'
import { isWorktreeCreatePreparation } from '../../shared/worktree/create-preparation'
import { toWslExecutionSpace } from '../../shared/wsl-paths'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import {
  readCheckedOutBranchRef,
  readRepoCommonDirFromGit,
  readRepoLocation,
  readTranslatedWorktreeGraph,
  readWorktreeHeadOid,
  readWorktreeList
} from './worktree-list-reader'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import {
  WORKTREE_LIST_TIMEOUT_MS,
  getErrorCode,
  isNotGitRepositoryError,
  normalizeLocalBranchRef
} from './worktree-operation-options'
import { areWorktreePathsEqual, translateWorktreePath } from './worktree-path-comparison'
import { detectSparseCheckoutCached } from './worktree-sparse-checkout-cache'

const SPARSE_CHECKOUT_DETECTION_CONCURRENCY = 8

export async function listWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    const worktrees = await readTranslatedWorktreeGraph(repoPath, options)
    return options.includeCreatePreparations
      ? worktrees
      : worktrees.filter((worktree) => !isWorktreeCreatePreparation(worktree))
  } catch (err) {
    if (await isTrueEmptyWorktreeListing(repoPath, err)) {
      return []
    }
    console.warn(`[git/worktree] listWorktreeGraph failed for ${repoPath}:`, err)
    return []
  }
}

export async function listWorktreesUnshared(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    const worktrees = await readTranslatedWorktreeGraph(repoPath, options)
    const visibleWorktrees = options.includeCreatePreparations
      ? worktrees
      : worktrees.filter((worktree) => !isWorktreeCreatePreparation(worktree))
    return annotateSparseCheckoutStatus(repoPath, visibleWorktrees, options)
  } catch (err) {
    if (await isTrueEmptyWorktreeListing(repoPath, err)) {
      return []
    }
    console.warn(`[git/worktree] listWorktrees failed for ${repoPath}:`, err)
    return []
  }
}

/** Only a missing path or confirmed non-repo permits an authoritative empty listing. */
async function isTrueEmptyWorktreeListing(repoPath: string, err: unknown): Promise<boolean> {
  if (getErrorCode(err) === 'ENOENT') {
    try {
      await stat(repoPath)
    } catch (statErr) {
      if (getErrorCode(statErr) === 'ENOENT') {
        console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
        return true
      }
    }
  }
  return isNotGitRepositoryError(err)
}

export async function listWorktreesStrict(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const worktrees = (await readWorktreeList(repoPath, options)).map((worktree) => {
    const translatedPath = translateWorktreePath(worktree.path, repoPath, options)
    return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
  })
  const visibleWorktrees = options.includeCreatePreparations
    ? worktrees
    : worktrees.filter((worktree) => !isWorktreeCreatePreparation(worktree))
  return annotateSparseCheckoutStatus(repoPath, visibleWorktrees, options)
}

/** Reject scan failures to prevent pruning valid worktrees and tabs; confirmed missing/non-repos return []. */
export async function listWorktreesStrictAllowingTrueEmpty(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    return await listWorktreesStrict(repoPath, options)
  } catch (err) {
    if (await isTrueEmptyWorktreeListing(repoPath, err)) {
      return []
    }
    throw err
  }
}

export async function annotateSparseCheckoutStatus(
  repoPath: string,
  worktrees: GitWorktreeInfo[],
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function detectNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      throwIfSignalAborted(options.signal)
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      if (!worktree || worktree.isBare || worktree.isSparse) {
        continue
      }
      const isSparse = await detectSparseCheckoutCached(repoPath, worktree.path, options)
      throwIfSignalAborted(options.signal)
      if (isSparse) {
        annotated[index] = { ...worktree, isSparse }
      }
    }
  }

  const workerCount = Math.min(SPARSE_CHECKOUT_DETECTION_CONCURRENCY, worktrees.length)
  await waitForPromiseWithSignal(
    Promise.all(Array.from({ length: workerCount }, () => detectNext())),
    options.signal
  )
  throwIfSignalAborted(options.signal)
  return annotated
}

/** Bound the disk witness on hung mounts; absent .git returns undefined, other read failures reject. */
async function readRepoCommonDirFromDisk(
  repoPath: string,
  timeoutMs: number
): Promise<string | undefined> {
  const dotGit = join(repoPath, '.git')
  try {
    const commonDir = await withDeadline(resolveRepoCommonDirFromDisk(repoPath, dotGit), timeoutMs)
    return commonDir ? toWslExecutionSpace(commonDir) : undefined
  } catch (error) {
    // A bare repo has no `.git`; do not fabricate a candidate for it.
    if (isDefinitiveAbsence(error)) {
      return undefined
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`repo common dir unverifiable: could not read ${dotGit}: ${reason}`, {
      cause: error
    })
  }
}

async function resolveRepoCommonDirFromDisk(
  repoPath: string,
  dotGit: string
): Promise<string | undefined> {
  // The general metadata resolvers are intentionally best effort; a witness must preserve read failures.
  const dotGitStats = await stat(dotGit)
  let gitDir = dotGit
  if (!dotGitStats.isDirectory()) {
    const pointer = parseGitdirMarkerPayload(await readFile(dotGit, 'utf8'))
    if (!pointer) {
      return undefined
    }
    gitDir = resolveGitMetadataPath(repoPath, pointer) ?? dotGit
    await assertGitDirIsDirectory(gitDir)
  }

  return readCommonDirMarker(gitDir)
}

/** Reject unreadable marker targets before commondir absence can be mistaken for a bare repo. */
async function assertGitDirIsDirectory(gitDir: string): Promise<void> {
  let gitDirStats
  try {
    gitDirStats = await stat(gitDir)
  } catch (error) {
    // Hide this errno from the outer missing-.git check.
    throw new Error(`gitdir marker target unreadable: ${gitDir}`, { cause: error })
  }
  if (!gitDirStats.isDirectory()) {
    throw new Error(`gitdir marker target is not a directory: ${gitDir}`)
  }
}

async function readCommonDirMarker(gitDir: string): Promise<string> {
  try {
    const pointer = await readFile(join(gitDir, 'commondir'), 'utf8')
    return resolveGitMetadataPath(gitDir, pointer) ?? gitDir
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return gitDir
  }
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline exceeded')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function canonicalizeLocalPath(pathValue: string): Promise<string> {
  try {
    return await realpath(pathValue)
  } catch {
    // Paths from another execution space may have no local inode.
    return pathValue
  }
}

/** Git and disk witnesses may differ through symlinks or WSL path spelling; accept any matching candidate. */
async function isSameRepoCommonDir(
  createdCommonDir: string,
  candidates: readonly (string | undefined)[]
): Promise<boolean> {
  const present = candidates.filter((candidate): candidate is string => Boolean(candidate))
  if (present.some((candidate) => areWorktreePathsEqual(createdCommonDir, candidate))) {
    return true
  }
  const [canonicalCreated, ...canonicalCandidates] = await Promise.all(
    [createdCommonDir, ...present].map(canonicalizeLocalPath)
  )
  return canonicalCandidates.some((candidate) => areWorktreePathsEqual(canonicalCreated, candidate))
}

/** Recover an omitted listing row only when Git confirms the expected branch, HEAD and repo object store. */
export async function describeCreatedWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo | undefined> {
  const expectedRef = `refs/heads/${normalizeLocalBranchRef(branch)}`
  // Bound Git recovery separately; filesystem canonicalization remains best effort.
  const deadlined: GitWorktreeExecOptions = {
    ...options,
    timeout: options.timeout ?? WORKTREE_LIST_TIMEOUT_MS
  }
  const [created, repoGitCommonDir, checkedOutRef, head] = await Promise.all([
    readRepoLocation(worktreePath, toWslExecutionSpace(worktreePath), deadlined),
    readRepoCommonDirFromGit(repoPath, deadlined),
    readCheckedOutBranchRef(worktreePath, deadlined),
    readWorktreeHeadOid(worktreePath, deadlined)
  ])
  if (!created || checkedOutRef !== expectedRef || !head) {
    return undefined
  }
  if (!(await isSameRepoCommonDir(created.commonDir, [repoGitCommonDir]))) {
    // Defer disk witnesses: a hung mount can pin a threadpool thread even after the deadline.
    const repoDiskCommonDir = await readRepoCommonDirFromDisk(
      repoPath,
      deadlined.timeout ?? WORKTREE_LIST_TIMEOUT_MS
    )
    if (!(await isSameRepoCommonDir(created.commonDir, [repoDiskCommonDir]))) {
      return undefined
    }
  }
  const [described] = await annotateSparseCheckoutStatus(
    repoPath,
    [
      {
        path: translateWorktreePath(created.topLevel, repoPath, options),
        head,
        branch: expectedRef,
        isBare: false,
        isMainWorktree: false
      }
    ],
    options
  )
  return described
}
