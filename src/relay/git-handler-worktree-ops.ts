/**
 * Worktree management and commit operations for the relay git handler.
 *
 * Why: extracted from git-handler-ops.ts to keep all relay files under
 * the oxlint max-lines (300) limit.
 */
import * as path from 'path'
import type { RemoveWorktreeResult } from '../shared/types'
import { resolveWorktreeAddBaseRef } from '../shared/worktree-base-ref'
import type { GitExec } from './git-handler-ops'
import { parseWorktreeList } from './git-handler-utils'

// ─── Worktree management ─────────────────────────────────────────────

async function persistRelayWorktreeCreationBase(
  git: GitExec,
  targetDir: string,
  branchName: string,
  effectiveBase: string
): Promise<void> {
  const configKey = `branch.${branchName}.base`
  try {
    await git(['config', '--local', '--replace-all', configKey, effectiveBase], targetDir)
  } catch (error) {
    console.warn(`relay addWorktree: failed to set ${configKey} for ${targetDir}`, error)
    try {
      // Why: SSH worktree creation shares branch config by name; clear stale
      // metadata if replacing an old same-name base fails.
      await git(['config', '--local', '--unset-all', configKey], targetDir)
    } catch (unsetError) {
      console.warn(
        `relay addWorktree: failed to unset stale ${configKey} for ${targetDir}`,
        unsetError
      )
    }
  }
}

export async function addWorktreeOp(git: GitExec, params: Record<string, unknown>): Promise<void> {
  const repoPath = params.repoPath as string
  const branchName = params.branchName as string
  const targetDir = params.targetDir as string
  const base = params.base as string | undefined
  const checkoutExistingBranch = params.checkoutExistingBranch === true
  const noCheckout = params.noCheckout === true

  // Why: a branchName starting with '-' would be interpreted as a git flag,
  // potentially changing the command's semantics (e.g. "--detach").
  if (branchName.startsWith('-') || (base && base.startsWith('-'))) {
    throw new Error('Branch name and base ref must not start with "-"')
  }

  // Why: --no-track + push.autoSetupRemote=true mirrors the local
  // addWorktree path (src/main/git/worktree.ts). Keeping the SSH path in
  // sync prevents a transport-only divergence where "Orca creates a
  // worktree" produces a different `git status` / `git push` UX based on
  // whether the repo is local or SSH-mounted. See full design rationale
  // (state machine, common-dir scope, old-git fallback) in the comments
  // around src/main/git/worktree.ts addWorktree — those invariants apply
  // identically here.
  const effectiveBase =
    base && !checkoutExistingBranch
      ? await resolveWorktreeAddBaseRef(base, async (qualifiedRef) => {
          try {
            await git(['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`], repoPath)
            return true
          } catch {
            return false
          }
        })
      : undefined

  const args = checkoutExistingBranch
    ? ['worktree', 'add', targetDir, branchName]
    : ['worktree', 'add', '--no-track', '-b', branchName, targetDir]
  if (!checkoutExistingBranch && noCheckout) {
    args.splice(3, 0, '--no-checkout')
  }
  if (effectiveBase) {
    args.push(effectiveBase)
  }

  await git(args, repoPath)

  if (checkoutExistingBranch) {
    return
  }

  if (effectiveBase) {
    await persistRelayWorktreeCreationBase(git, targetDir, branchName, effectiveBase)
  }

  // Why: best-effort write so a deliberate user value (any scope) is
  // preserved and a real read failure is not silently overwritten. Final
  // catch is warn-only — if the remote host's git is <2.37 the value is
  // ignored at push time and the user falls back to `git push -u` once.
  // (Note: it is the SSH host's git that matters here, not the client's.)
  // Mirrors local addWorktree exactly.
  try {
    let alreadySet = false
    try {
      await git(['config', '--get', 'push.autoSetupRemote'], targetDir)
      alreadySet = true
    } catch (readError) {
      // Why: `git config --get` exits 1 only when the key is unset at every
      // scope. Any other code is a real read failure (corrupt config,
      // locked file) — surface it via the outer catch instead of falling
      // through to overwrite the user's actual value.
      const code = (readError as { code?: unknown })?.code
      if (code !== 1) {
        throw readError
      }
    }
    if (!alreadySet) {
      await git(['config', '--local', 'push.autoSetupRemote', 'true'], targetDir)
    }
  } catch (error) {
    console.warn(`relay addWorktree: failed to set push.autoSetupRemote for ${targetDir}`, error)
  }
}

export async function removeWorktreeOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<RemoveWorktreeResult> {
  const worktreePath = params.worktreePath as string
  const force = params.force as boolean | undefined
  const deleteBranch = params.deleteBranch !== false
  const forceBranchDelete = params.forceBranchDelete === true

  let repoPath = worktreePath
  try {
    const { stdout } = await git(['rev-parse', '--git-common-dir'], worktreePath)
    const commonDir = stdout.trim()
    if (commonDir && commonDir !== '.git') {
      repoPath = path.resolve(worktreePath, commonDir, '..')
    }
  } catch {
    // fall through with worktreePath as repo
  }

  const worktreesBeforeRemoval = await listRelayWorktrees(git, repoPath)
  const removedWorktree = worktreesBeforeRemoval.find((worktree) =>
    areRelayWorktreePathsEqual(worktree.path, worktreePath)
  )
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')
  const branchHead = removedWorktree?.head ?? ''

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  await git(args, repoPath)
  await git(['worktree', 'prune'], repoPath)

  if (!branchName) {
    return {}
  }
  if (!deleteBranch) {
    return {}
  }

  // Why: SSH worktree deletion should mirror local deletion. Dropping the
  // branch also removes its upstream config, which lets fork-remotes cleanup
  // after the last PR review worktree is gone.
  const worktreesAfterPrune = await listRelayWorktrees(git, repoPath)
  const branchStillInUse = worktreesAfterPrune.some(
    (worktree) => normalizeLocalBranchRef(worktree.branch ?? '') === branchName
  )
  if (branchStillInUse) {
    return {}
  }

  try {
    // Why: use `-d` (not `-D`) to mirror the local removeWorktree fix — Git
    // refuses to delete a branch with commits not merged into its upstream or
    // HEAD, so unpublished work on a remote worktree is preserved rather than
    // force-deleted. forceBranchDelete is reserved for failed create rollback.
    await git(['branch', forceBranchDelete ? '-D' : '-d', '--', branchName], repoPath)
    return {}
  } catch (error) {
    // Expected when the branch still has unmerged/unpublished commits: keep it.
    console.warn(
      `relay removeWorktree: preserved local branch "${branchName}" after removing worktree (not fully merged)`,
      error
    )
    return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
  }
}

type RelayWorktreeInfo = {
  path: string
  branch?: string
  head?: string
}

async function listRelayWorktrees(git: GitExec, repoPath: string): Promise<RelayWorktreeInfo[]> {
  try {
    const { stdout } = await git(['worktree', 'list', '--porcelain'], repoPath)
    return parseWorktreeList(stdout)
      .map((worktree) => ({
        path: typeof worktree.path === 'string' ? worktree.path : '',
        head: typeof worktree.head === 'string' ? worktree.head : undefined,
        branch: typeof worktree.branch === 'string' ? worktree.branch : undefined
      }))
      .filter((worktree) => worktree.path.length > 0)
  } catch {
    return []
  }
}

function normalizeLocalBranchRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function areRelayWorktreePathsEqual(leftPath: string, rightPath: string): boolean {
  const left = path.normalize(path.resolve(leftPath))
  const right = path.normalize(path.resolve(rightPath))
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function worktreeIsCleanOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<{ clean: boolean; stdout?: string }> {
  const worktreePath = params.worktreePath as string
  const { stdout } = await git(['status', '--porcelain', '--untracked-files=all'], worktreePath)
  const clean = !stdout.trim()
  return { clean, stdout: clean ? undefined : stdout }
}

// ─── Commit ──────────────────────────────────────────────────────────

export async function commitChangesRelay(
  git: GitExec,
  worktreePath: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  // Why: defense-in-depth. The IPC handler at src/main/ipc/filesystem.ts validates
  // the message, but a relay caller (future automation, or an SSH client connecting
  // to the relay directly) could bypass that path. Reject empty/whitespace messages
  // here so we surface a clear error instead of git's opaque failure.
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { success: false, error: 'Commit message is required' }
  }

  try {
    await git(['commit', '-m', message], worktreePath)
    return { success: true }
  } catch (error) {
    // Why: surface whichever channel carries the useful message. Pre-commit/GPG
    // hook failures write to stderr; "nothing to commit, working tree clean"
    // writes to stdout. Try stderr first, fall back to stdout, then error.message.
    // Mirrors commitChanges in src/main/git/status.ts — keep the two paths in sync.
    const readStringField = (field: string): string | null => {
      if (typeof error === 'object' && error && field in error) {
        const v = (error as Record<string, unknown>)[field]
        if (typeof v === 'string' && v.length > 0) {
          return v
        }
      }
      return null
    }
    const errorMessage =
      readStringField('stderr') ??
      readStringField('stdout') ??
      (error instanceof Error ? error.message : 'Commit failed')
    return { success: false, error: errorMessage }
  }
}
