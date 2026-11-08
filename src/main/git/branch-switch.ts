import type {
  BranchSwitchTarget,
  BranchSwitchCreation
} from '../../shared/git/branch-switch-target'
import {
  resolveBranchSwitchTarget,
  branchSwitchFailure,
  branchSwitchTrackingFailure,
  readCurrentBranch,
  readBranchSwitchHead
} from './branch-switch-target'
import { access } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitStatusResult } from '../../shared/git/status/git-status-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isGitWorktreeMutationInFlight } from './command-runner/git-worktree-mutation-state'
import { resolveGitDir } from './source-control/resolve-git-dir'
import { gitOptionsForWorktree, type GitRuntimeOptions } from './git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from './runner'
import { parseCheckoutSkippedPaths } from './checkout-skipped-paths'
import { readGitCommandFailureStderr } from '../../shared/git/commands/git-command-failure-text'

/** A switch Orca refused before touching the checkout; the message is shown to the user as-is. */
export class BranchSwitchRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BranchSwitchRefusedError'
  }
}

/** The switch landed, but git reported a problem (files left behind, a failed hook); shown as-is. */
export class BranchSwitchLandedWithWarningError extends Error {
  constructor(
    message: string,
    readonly branch: string,
    readonly head?: string
  ) {
    super(message)
    this.name = 'BranchSwitchLandedWithWarningError'
  }
}

function filesLeftBehindMessage(branch: string, skippedPaths: readonly string[]): string {
  const files = skippedPaths.length === 1 ? '1 file' : `${skippedPaths.length} files`
  const pronoun = skippedPaths.length === 1 ? 'it' : 'them'
  return `Switched to ${branch}, but ${files} kept the old branch's content because another program has ${pronoun} open (${skippedPaths[0]}). Close that program, then discard the changes Orca shows for ${pronoun} to finish the switch.`
}

/** Git's own progress lines on stderr; never the reason a switch reported an error. */
const GIT_CHECKOUT_PROGRESS =
  /^(Switched to( a new)? branch|Already on|Your branch|Previous HEAD position|HEAD is now at)\b/

/** Prefer git's own error line; else the last line that is not git progress (a hook's output). */
export function gitFailureLine(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    // WSL git runs in an interactive login shell, which writes `logout` to stderr as it exits.
    .filter((line) => line && line !== 'logout' && !GIT_CHECKOUT_PROGRESS.test(line))
  return lines.find((line) => /^(error|fatal):/.test(line)) ?? lines.at(-1) ?? null
}

export type BranchSwitchDeps = {
  /** Status as the panel reads it, so Orca's own shared-path symlinks don't count as changes. */
  getStatus: () => Promise<GitStatusResult>
  /** The provider's checkout, so the user's switch keeps the interactive git queue. */
  checkout: (branch: string, creation?: BranchSwitchCreation) => Promise<{ skippedPaths: string[] }>
  /** A user-facing reason when an agent is working in this checkout, else null. */
  getAgentBlocker: () => Promise<string | null>
  /** Record the user's choice before the lock lets a queued first-work rename look at the branch. */
  onSwitched?: () => void
}

export type BranchSwitchResult = {
  branch: string
  head?: string
  /** The live branch the checkout left, or null when it was already on `branch`. */
  previousBranch: string | null
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

/** Submodule `ignore` config hides edits from the panel's status; refuse only on edits inside one. */
async function firstHiddenSubmoduleEdit(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  const execution = {
    ...gitOptionsForWorktree(worktreePath, { ...options, admissionTier: 'interactive' }),
    env: gitOptionalLocksDisabledEnv()
  }
  // No gitlink in the index, nothing hidden: skip a second working-tree walk on every switch.
  // The index decides, not `.gitmodules` on disk (sparse checkout can omit it while git still
  // reads submodule config from the index). Modes only keep large indexes under the output cap;
  // a failed, overflowing or too-old-git read probes anyway.
  const index = await gitExecFileAsync(
    ['ls-files', '-z', '--format=%(objectmode)'],
    execution
  ).catch(() => null)
  if (index !== null && !index.stdout.split('\0').includes('160000')) {
    return null
  }
  const { stdout } = await gitExecFileAsync(
    ['status', '--porcelain=v2', '--untracked-files=no', '--ignore-submodules=none'],
    execution
  )
  for (const line of stdout.split('\n')) {
    // `1 XY S<c><m><u> …`: m means tracked edits inside (untracked ones are not listed here and a
    // switch cannot lose them); a commit mismatch alone is left alone, since checkout never
    // touches a submodule's working tree.
    const fields = line.split(' ')
    const sub = fields[2] ?? ''
    if (
      (fields[0] === '1' || fields[0] === '2') &&
      sub.startsWith('S') &&
      /[MU]/.test(sub.slice(2))
    ) {
      return fields
        .slice(fields[0] === '1' ? 8 : 9)
        .join(' ')
        .split('\t')[0]
    }
  }
  return null
}

async function readRefusal(
  worktreePath: string,
  branch: string,
  creating: boolean,
  options: GitRuntimeOptions,
  deps: BranchSwitchDeps,
  commitTarget: boolean
): Promise<{ refusal: string | null; previousBranch: string | null; alreadyOnTarget: boolean }> {
  const status = await deps.getStatus()
  if (status.readError !== undefined) {
    return {
      refusal: `Orca couldn't read this checkout's changes, so it didn't switch branches. ${status.readError}`,
      previousBranch: null,
      alreadyOnTarget: false
    }
  }
  const current = status.branch?.replace(/^refs\/heads\//, '')
  if (
    !creating &&
    ((!commitTarget && current === branch) ||
      (current === undefined && commitTarget && status.head === branch))
  ) {
    return { refusal: null, previousBranch: null, alreadyOnTarget: true }
  }
  const refuse = (refusal: string | null) => ({
    refusal,
    previousBranch: current ?? null,
    alreadyOnTarget: false
  })
  if (status.head === '(initial)') {
    return refuse('Make a first commit on this branch before switching branches.')
  }
  if (current === undefined) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-list', '-n1', 'HEAD', '--not', '--branches', '--remotes', '--tags'],
        gitOptionsForWorktree(worktreePath, options)
      )
      if (stdout.trim()) {
        return refuse(
          'This checkout is on a detached commit. Switch branches from a terminal so commits made here are not lost.'
        )
      }
    } catch (error) {
      return refuse(
        `Orca couldn't read this checkout's changes, so it didn't switch branches. ${error instanceof Error ? error.message : String(error)}`
      )
    }
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
  if (!creating) {
    if (status.entries.length > 0) {
      return refuse(changedFilesReason(status))
    }
    const hiddenSubmodule = await firstHiddenSubmoduleEdit(worktreePath, options)
    if (hiddenSubmodule) {
      return refuse(
        `Commit, stash or clean the changes inside submodule ${hiddenSubmodule} before switching branches.`
      )
    }
  }
  return refuse(await deps.getAgentBlocker())
}

/** Switch or create a branch in place, refusing when the checkout is not safe to switch. */
export async function switchBranchGuarded(
  worktreePath: string,
  target: string | BranchSwitchTarget | { commitId: string },
  options: GitRuntimeOptions,
  deps: BranchSwitchDeps
): Promise<BranchSwitchResult> {
  const commitTarget = typeof target !== 'string' && 'commitId' in target
  const commitId = commitTarget ? target.commitId.toLowerCase() : undefined
  if (commitId !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitId)) {
    throw new Error('Expected a full git object id')
  }
  return withCheckoutLock(worktreePath, async () => {
    const resolved: { branch: string; creation?: BranchSwitchCreation } =
      typeof target === 'string'
        ? { branch: target }
        : 'commitId' in target
          ? { branch: target.commitId.toLowerCase() }
          : await resolveBranchSwitchTarget(worktreePath, target, options)
    const { branch } = resolved
    const creating = typeof target !== 'string' && 'kind' in target && target.kind === 'new'
    const { refusal, previousBranch, alreadyOnTarget } = await readRefusal(
      worktreePath,
      branch,
      creating,
      options,
      deps,
      commitTarget
    )
    if (refusal !== null) {
      throw new BranchSwitchRefusedError(refusal)
    }
    if (alreadyOnTarget && !creating) {
      return { branch, previousBranch, head: await readBranchSwitchHead(worktreePath, options) }
    }
    let skippedPaths: string[]
    try {
      ;({ skippedPaths } = await deps.checkout(branch, resolved.creation))
    } catch (error) {
      // Git can exit non-zero after HEAD already moved (a file it could not replace, a failing
      // post-checkout hook); that switch landed and must be recorded.
      const landedTarget = commitTarget
        ? await readBranchSwitchHead(worktreePath, options)
        : await readCurrentBranch(worktreePath, options)
      if (
        (creating && previousBranch === branch) ||
        landedTarget !== branch ||
        (commitTarget && (await readCurrentBranch(worktreePath, options)) !== null)
      ) {
        if (commitTarget) {
          throw new Error(
            gitFailureLine(readGitCommandFailureStderr(error) ?? '') ??
              "Orca couldn't check out this commit. Check this repository in a terminal, then try again."
          )
        }
        throw typeof target === 'string' ? error : branchSwitchFailure(error, branch)
      }
      deps.onSwitched?.()
      const stderr = readGitCommandFailureStderr(error) ?? ''
      const failed = parseCheckoutSkippedPaths(stderr)
      const tracking =
        typeof target === 'string' ? null : branchSwitchTrackingFailure(stderr, branch)
      const detail = gitFailureLine(stderr)
      throw new BranchSwitchLandedWithWarningError(
        failed.length > 0
          ? filesLeftBehindMessage(branch, failed)
          : tracking
            ? `Switched to ${branch}, but ${tracking}`
            : detail && /^(error|fatal):/.test(detail)
              ? `Switched to ${branch}, but git reported: ${detail}`
              : detail
                ? `Switched to ${branch}. A git hook in this repository failed afterwards and said: ${detail}. The switch itself worked.`
                : `Switched to ${branch}. A git hook or git step in this repository failed afterwards. The switch itself worked.`,
        branch,
        commitTarget ? landedTarget : await readBranchSwitchHead(worktreePath, options)
      )
    }
    deps.onSwitched?.()
    if (skippedPaths.length > 0) {
      throw new BranchSwitchLandedWithWarningError(
        filesLeftBehindMessage(branch, skippedPaths),
        branch,
        await readBranchSwitchHead(worktreePath, options)
      )
    }
    return { branch, previousBranch, head: await readBranchSwitchHead(worktreePath, options) }
  })
}
