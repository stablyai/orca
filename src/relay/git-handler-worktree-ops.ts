/**
 * Worktree management and commit operations for the relay git handler.
 *
 * Why: extracted from git-handler-ops.ts to keep all relay files under
 * the oxlint max-lines (300) limit.
 */
import * as path from 'path'
import type { GitExec } from './git-handler-ops'

// ─── Worktree management ─────────────────────────────────────────────

export async function addWorktreeOp(git: GitExec, params: Record<string, unknown>): Promise<void> {
  const repoPath = params.repoPath as string
  const branchName = params.branchName as string
  const targetDir = params.targetDir as string
  const base = params.base as string | undefined

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
  const args = ['worktree', 'add', '--no-track', '-b', branchName, targetDir]
  if (base) {
    args.push(base)
  }

  await git(args, repoPath)

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
): Promise<void> {
  const worktreePath = params.worktreePath as string
  const force = params.force as boolean | undefined

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

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  await git(args, repoPath)
  await git(['worktree', 'prune'], repoPath)
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
