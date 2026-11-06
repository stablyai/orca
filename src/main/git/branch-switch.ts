import { access } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitStatusResult } from '../../shared/git/status/git-status-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { checkoutBranch } from './checkout'
import type { GitRuntimeOptions } from './git-runtime-options'
import { isGitWorktreeMutationInFlight } from './command-runner/git-worktree-mutation-state'
import { resolveGitDir } from './source-control/resolve-git-dir'

/** A switch Orca refused before touching the checkout; the message is shown to the user as-is. */
export class BranchSwitchRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BranchSwitchRefusedError'
  }
}

export type BranchSwitchDeps = {
  /** Status as the panel reads it, so Orca's own shared-path symlinks don't count as changes. */
  getStatus: () => Promise<GitStatusResult>
  /** A user-facing reason when an agent is working in this checkout, else null. */
  getAgentBlocker: () => Promise<string | null>
  /** Record the user's choice before the lock lets a queued first-work rename look at the branch. */
  onSwitched?: () => void
}

export type BranchSwitchResult = {
  branch: string
  /** The live branch the checkout left, or null when it was already on `branch`. */
  previousBranch: string | null
  /** Files git could not update (e.g. held open on Windows) and left differing from the new branch. */
  leftoverPaths: string[]
}

const checkoutLocks = new Map<string, Promise<unknown>>()

/** Serialize check-then-move of a checkout's branch: switches from any client and first-work renames. */
export async function withCheckoutLock<T>(worktreePath: string, run: () => Promise<T>): Promise<T> {
  const key = normalizeRuntimePathForComparison(worktreePath)
  const previous = checkoutLocks.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(run)
  const settled = current.catch(() => {})
  checkoutLocks.set(key, settled)
  try {
    return await current
  } finally {
    if (checkoutLocks.get(key) === settled) {
      checkoutLocks.delete(key)
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function changedFilesReason(status: GitStatusResult): string {
  const count = status.statusLength ?? status.entries.length
  const first = status.entries[0]
  const submodule = status.entries.find((entry) => entry.submodule)
  if (submodule) {
    return `Commit, stash or clean the changes inside submodule ${submodule.path} before switching branches.`
  }
  if (first && first.path.startsWith('.orca/browser-downloads/')) {
    return `Move or delete the downloaded file ${first.path} before switching branches.`
  }
  const files = count === 1 ? `1 changed file (${first?.path ?? ''})` : `${count} changed files`
  return `Commit or discard ${files} before switching branches.`
}

async function readRefusal(
  worktreePath: string,
  branch: string,
  options: GitRuntimeOptions,
  deps: BranchSwitchDeps
): Promise<{ refusal: string | null; previousBranch: string | null }> {
  const status = await deps.getStatus()
  if (status.readError !== undefined) {
    return {
      refusal: `Orca couldn't read this checkout's changes, so it didn't switch branches. ${status.readError}`,
      previousBranch: null
    }
  }
  const current = status.branch?.replace(/^refs\/heads\//, '')
  if (current === branch) {
    return { refusal: null, previousBranch: null }
  }
  const refuse = (refusal: string | null) => ({ refusal, previousBranch: current ?? null })
  if (status.head === '(initial)') {
    return refuse('Make a first commit on this branch before switching branches.')
  }
  if (current === undefined) {
    return refuse(
      'This checkout is on a detached commit. Switch branches from a terminal so commits made here are not lost.'
    )
  }
  const revertInProgress = await exists(
    path.join(await resolveGitDir(worktreePath, options), 'REVERT_HEAD')
  )
  const operation = status.conflictOperation !== 'unknown' ? status.conflictOperation : null
  if (operation ?? revertInProgress) {
    return refuse(
      `Finish or abort the ${operation ?? 'revert'} in progress before switching branches.`
    )
  }
  if (await isGitWorktreeMutationInFlight(worktreePath, options)) {
    return refuse(
      'Another git action is still running in this checkout. Try again when it finishes.'
    )
  }
  if (status.entries.length > 0) {
    return refuse(changedFilesReason(status))
  }
  return refuse(await deps.getAgentBlocker())
}

/** Switch an existing local branch in place, refusing when the checkout is not safe to switch. */
export async function switchBranchGuarded(
  worktreePath: string,
  branch: string,
  options: GitRuntimeOptions,
  deps: BranchSwitchDeps
): Promise<BranchSwitchResult> {
  return withCheckoutLock(worktreePath, async () => {
    const { refusal, previousBranch } = await readRefusal(worktreePath, branch, options, deps)
    if (refusal !== null) {
      throw new BranchSwitchRefusedError(refusal)
    }
    if (previousBranch === null) {
      return { branch, previousBranch, leftoverPaths: [] }
    }
    await checkoutBranch(worktreePath, branch, options)
    deps.onSwitched?.()
    // Git for Windows can skip a file another program holds open and still exit 0.
    const after = await deps.getStatus()
    return { branch, previousBranch, leftoverPaths: after.entries.map((entry) => entry.path) }
  })
}
