import { realpath, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
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
import { resolveGitCommonDir } from './worktree-sparse-state'
import { resolveGitDir } from './source-control/resolve-git-dir'

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
    if (getErrorCode(err) === 'ENOENT') {
      try {
        await stat(repoPath)
      } catch (statErr) {
        if (getErrorCode(statErr) === 'ENOENT') {
          console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
          return []
        }
      }
    }
    if (isNotGitRepositoryError(err)) {
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
    if (getErrorCode(err) === 'ENOENT') {
      try {
        await stat(repoPath)
      } catch (statErr) {
        if (getErrorCode(statErr) === 'ENOENT') {
          console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
          return []
        }
      }
    }
    if (isNotGitRepositoryError(err)) {
      return []
    }
    // Why: don't swallow git-compat/repo-state failures — else they resurface as opaque "created but not found in listing" errors.
    console.warn(`[git/worktree] listWorktrees failed for ${repoPath}:`, err)
    return []
  }
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

export async function annotateSparseCheckoutStatus(
  repoPath: string,
  worktrees: GitWorktreeInfo[],
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function detectNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      if (!worktree || worktree.isBare || worktree.isSparse) {
        continue
      }
      const isSparse = await detectSparseCheckoutCached(repoPath, worktree.path, options)
      if (isSparse) {
        annotated[index] = { ...worktree, isSparse }
      }
    }
  }

  // Why: cap concurrency so status-poll refreshes don't fan out many sparse-checkout filesystem probes at once.
  const workerCount = Math.min(SPARSE_CHECKOUT_DETECTION_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => detectNext()))
  return annotated
}

/**
 * The repo's common dir from the filesystem, as a second opinion on Git's own reading.
 *
 * Deadlined because a `.git` on a hung mount (dead NFS/SSHFS, stalled WSL 9p) never rejects, and an
 * unbounded read here would leave the whole create IPC pending instead of failing like it used to.
 */
async function readRepoCommonDirFromDisk(
  repoPath: string,
  timeoutMs: number
): Promise<string | undefined> {
  try {
    const dotGit = join(repoPath, '.git')
    // A bare repo has no `.git`, and resolveGitDir would fabricate one; offer no candidate instead.
    await withDeadline(stat(dotGit), timeoutMs)
    const commonDir = await withDeadline(
      resolveGitDir(repoPath).then(resolveGitCommonDir),
      timeoutMs
    )
    // Node answers in the caller's space, Git in the distro's. Without this the WSL candidate is a UNC
    // path that can never equal Git's `/home/...`, leaving this witness inert on exactly the fallback
    // path that needs it (realpath cannot bridge the two: a Linux path has no local inode).
    return toWslExecutionSpace(commonDir)
  } catch {
    return undefined
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
    // A path Git reported from another execution space (WSL, SSH) has no local inode.
    return pathValue
  }
}

/**
 * Whether the created worktree's common dir names the same object store as the repo.
 *
 * Why accept any candidate: the readings come from different spaces — Git resolves symlinks and,
 * under WSL, answers in Linux paths, while the filesystem walk keeps the caller's (possibly UNC)
 * spelling. Comparing only one rejected every symlinked-root, WSL, and bare-repo create (#16520).
 */
async function isSameRepoCommonDir(
  createdCommonDir: string,
  candidates: readonly (string | undefined)[]
): Promise<boolean> {
  const present = candidates.filter((candidate): candidate is string => Boolean(candidate))
  if (present.some((candidate) => isSameCommonDirPath(createdCommonDir, candidate))) {
    return true
  }
  const [canonicalCreated, ...canonicalCandidates] = await Promise.all(
    [createdCommonDir, ...present].map(canonicalizeLocalPath)
  )
  return canonicalCandidates.some((candidate) => isSameCommonDirPath(canonicalCreated, candidate))
}

/**
 * Why not areWorktreePathsEqual alone: it folds case for every path once the host is Windows, so on
 * a Windows desktop two WSL repos differing only in case would be accepted as the same object store.
 */
export function isSameCommonDirPath(
  left: string,
  right: string,
  platform = process.platform
): boolean {
  const leftIsPosix = isPosixAbsolutePath(left)
  if (leftIsPosix || isPosixAbsolutePath(right)) {
    return leftIsPosix && isPosixAbsolutePath(right) && posix.resolve(left) === posix.resolve(right)
  }
  return areWorktreePathsEqual(left, right, platform)
}

function isPosixAbsolutePath(pathValue: string): boolean {
  return pathValue.startsWith('/') && !pathValue.startsWith('//')
}

/**
 * Reconstruct the listing row for a worktree `git worktree add` just created, by asking Git about
 * the worktree itself. Used when the listing fails or omits it, so a create does not abandon a
 * worktree Git already wrote to disk (#16520). Returns undefined unless Git resolves the path into
 * this repo's object store with the expected branch checked out.
 */
export async function describeCreatedWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo | undefined> {
  const expectedRef = `refs/heads/${normalizeLocalBranchRef(branch)}`
  // Bound Git recovery after the bounded listing failed; filesystem canonicalization stays best effort.
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
  // An unreadable HEAD means Git could not confirm the worktree, so report nothing rather than a blank OID.
  if (!created || checkedOutRef !== expectedRef || !head) {
    return undefined
  }
  if (!(await isSameRepoCommonDir(created.commonDir, [repoGitCommonDir]))) {
    // Only now read the second opinion from disk: a `.git` on a hung mount pins a threadpool thread
    // that no deadline can reclaim, so never pay that on the path where Git already agreed.
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
        // `git worktree add` only ever produces a linked worktree.
        isMainWorktree: false
      }
    ],
    options
  )
  return described
}
