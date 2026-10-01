// A create's use of a ready spare: claim it synchronously, then hand it over with the same result a
// plain `git worktree add -b` gives. Nothing here waits on a spare or deletes a tree; a failed
// handover puts the spare back where it was and leaves its removal to background work.
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import type { PreparedCheckoutOutcome } from '../../shared/worktree/create-types'
import { toHostFilesystemPath } from '../host-tree-removal'
import {
  findSpare,
  isSpareHookUnsupported,
  preparationPathKey,
  spareRepoKey,
  takeReadySpare,
  takeSpareStoppedForCreate,
  type SpareEntry
} from '../worktree-create-preparation-pool'
import { scheduleSpareDiscard } from '../worktree-create-spare-discard'
import { gitExecFileAsync } from './runner'
import {
  configurePushAutoSetupRemote,
  persistWorktreeCreationBase
} from './worktree-add-creation-config'
import { unlockPreparedWorktree } from './worktree-create-preparation'
import { releaseOwnedSpareId } from './worktree-create-spare-ids'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  type AddWorktreeOptions
} from './worktree-operation-options'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'

export type SpareCreateRequest = {
  repoPath: string
  worktreePath: string
  branch: string
  effectiveBase: string
  effectiveBaseOid?: string
  workspaceRoot: string
  options: AddWorktreeOptions
}

/** Whether the create used a spare; a miss means the caller runs the plain add. */
export async function createFromReadySpare(
  request: SpareCreateRequest
): Promise<PreparedCheckoutOutcome> {
  const repoKey = spareRepoKey(request.repoPath, request.options.wslDistro)
  const candidate = findSpare(repoKey)
  if (!candidate) {
    // Rule 1 shows up here: this create's start stopped a spare that was still building.
    if (takeSpareStoppedForCreate(repoKey)) {
      return { status: 'miss', reason: 'not_ready' }
    }
    return { status: 'miss', reason: isSpareHookUnsupported(repoKey) ? 'hook_unsupported' : 'none' }
  }
  if (candidate.state !== 'ready') {
    return { status: 'miss', reason: 'not_ready' }
  }
  // Paid only when a ready spare exists: the base context omits the commit after a local refresh.
  const targetHead =
    request.effectiveBaseOid ??
    (
      await gitExecFileAsync(
        ['rev-parse', '--verify', `${request.effectiveBase}^{commit}`],
        gitExecOptions(request.repoPath, request.options)
      )
    ).stdout.trim()
  const take = takeReadySpare(candidate, targetHead, preparationPathKey(request.workspaceRoot))
  if (take.status === 'miss') {
    return take
  }
  return handOverSpare(take.entry, request)
}

function git(args: string[], cwd: string, options: AddWorktreeOptions): Promise<unknown> {
  return gitExecFileAsync([...windowsLongPathGitArgs(cwd), ...args], {
    ...gitExecOptions(cwd, { ...options, signal: undefined }),
    timeout: resolveWorktreeAddTimeoutMs()
  })
}

function discardAt(spare: SpareEntry, path: string): void {
  scheduleSpareDiscard({ id: spare.id, repoPath: spare.repoPath, path, options: spare.options })
}

async function moveWorktree(
  repoPath: string,
  from: string,
  to: string,
  options: AddWorktreeOptions
) {
  try {
    // Why `-f -f`: moves the locked spare and keeps its lock reason (Git 2.25+).
    await git(['worktree', 'move', '-f', '-f', from, to], repoPath, options)
  } finally {
    // The move rewrites both `.git` markers, and a failure can have rewritten one.
    invalidateWslLinkedWorktreeGitRouting(from)
    invalidateWslLinkedWorktreeGitRouting(to)
  }
}

function pathOps(path: string): typeof posix {
  return isWindowsAbsolutePathLike(path) ? win32 : posix
}

/** Whether `<path>/.git` names this spare's admin entry: the move landed at the path itself. */
async function holdsSpare(path: string, spare: SpareEntry): Promise<boolean> {
  try {
    const marker = await readFile(toHostFilesystemPath(pathOps(path).join(path, '.git')), 'utf8')
    const gitDir = /^gitdir:\s*(.+)$/m.exec(marker)?.[1]?.trim().replace(/\\/g, '/') ?? ''
    return gitDir.endsWith(`/worktrees/${spare.id}`)
  } catch {
    return false
  }
}

const FINALIZE_FAILED: PreparedCheckoutOutcome = { status: 'miss', reason: 'finalize_failed' }

/** A hit when the worktree now exists at the target; a miss means the caller runs a plain add. */
async function handOverSpare(
  spare: SpareEntry,
  request: SpareCreateRequest
): Promise<PreparedCheckoutOutcome> {
  const { repoPath, worktreePath, branch, options } = request
  try {
    await mkdir(toHostFilesystemPath(pathOps(worktreePath).dirname(worktreePath)), {
      recursive: true
    })
    // `worktree move` into an existing directory lands inside it, so only a free path qualifies.
    const occupied = await lstat(toHostFilesystemPath(worktreePath)).then(
      () => true,
      (error: unknown) => !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    )
    if (occupied) {
      discardAt(spare, spare.preparedPath)
      return { status: 'miss', reason: 'target_exists' }
    }
    await moveWorktree(repoPath, spare.preparedPath, worktreePath, options)
  } catch (error) {
    console.warn('[worktree-create] spare checkout could not be moved; using a plain add', error)
    discardAt(spare, spare.preparedPath)
    return FINALIZE_FAILED
  }
  if (!(await holdsSpare(worktreePath, spare))) {
    // The path appeared after the check and the spare went inside it; never touch what is there.
    discardAt(spare, pathOps(worktreePath).join(worktreePath, spare.id))
    return FINALIZE_FAILED
  }
  let branchCreated = false
  try {
    await git(['branch', '--no-track', branch, spare.oid], repoPath, options)
    branchCreated = true
    await git(
      [
        'symbolic-ref',
        '-m',
        `checkout: moving from ${spare.oid} to ${branch}`,
        'HEAD',
        `refs/heads/${branch}`
      ],
      worktreePath,
      options
    )
  } catch (error) {
    console.warn(
      '[worktree-create] spare checkout could not take the branch; using a plain add',
      error
    )
    await putSpareBack(spare, request, branchCreated)
    return FINALIZE_FAILED
  }
  try {
    if (spare.hookRun) {
      // The arguments a plain add gives: no previous HEAD, the new HEAD, a branch checkout.
      // The hooks directory the repo resolves, as a plain add does, and the new worktree as the
      // work tree, so git calls from the hook's subdirectories see the checkout a plain add gives.
      const nullOid = '0'.repeat(spare.oid.length)
      const hooksPath = spare.hooksPath ? ['-c', `core.hooksPath=${spare.hooksPath}`] : []
      const hook = [
        'hook',
        'run',
        '--ignore-missing',
        'post-checkout',
        '--',
        nullOid,
        spare.oid,
        '1'
      ]
      await git([...hooksPath, '--work-tree', worktreePath, ...hook], worktreePath, options)
    }
  } catch (error) {
    // As on the plain path: a failing hook fails the create and keeps the worktree.
    await finishHandover(spare, repoPath, worktreePath, options)
    throw error
  }
  await persistWorktreeCreationBase(worktreePath, branch, request.effectiveBase, options)
  await configurePushAutoSetupRemote(worktreePath, options)
  await finishHandover(spare, repoPath, worktreePath, options)
  return { status: 'hit' }
}

async function putSpareBack(
  spare: SpareEntry,
  request: SpareCreateRequest,
  branchCreated: boolean
) {
  const { repoPath, worktreePath, branch, options } = request
  if (branchCreated) {
    await git(['branch', '-D', '--', branch], repoPath, options).catch(() => {})
  }
  if (!(await holdsSpare(worktreePath, spare))) {
    return
  }
  try {
    await moveWorktree(repoPath, worktreePath, spare.preparedPath, options)
  } catch (error) {
    // The target never held user work; it goes to background removal and the create fails.
    discardAt(spare, worktreePath)
    throw error
  }
  discardAt(spare, spare.preparedPath)
}

/** Unlocks the new worktree so listings show it; one background retry, then the sweep. */
async function finishHandover(
  spare: SpareEntry,
  repoPath: string,
  worktreePath: string,
  options: AddWorktreeOptions
): Promise<void> {
  const unlock = (): Promise<void> =>
    unlockPreparedWorktree(repoPath, worktreePath, { ...options, signal: undefined })
  try {
    await unlock()
    releaseOwnedSpareId(spare.id)
  } catch (error) {
    console.warn(`[worktree-create] could not unlock ${worktreePath}; retrying once`, error)
    void unlock()
      .catch((retryError: unknown) => {
        console.warn(`[worktree-create] ${worktreePath} stays hidden until relaunch`, retryError)
      })
      .finally(() => releaseOwnedSpareId(spare.id))
  }
}
