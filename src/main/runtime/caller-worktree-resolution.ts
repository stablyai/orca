import type { CurrentWorktreeContextHints } from '../../shared/current-worktree-context'

export type CallerWorktreeLookup<T> = {
  showTerminal(handle: string): Promise<{ worktreeId: string }>
  worktreeById(worktreeId: string): Promise<T>
  worktreeForPath(cwd: string): Promise<T | null>
}

/**
 * - `mismatch`: the worktree hint contradicts the caller's terminal.
 * - `unverified`: a remote or hinted caller whose terminal can't be checked; cwd isn't trusted then.
 * - `outside`: the caller isn't inside an Orca-managed worktree.
 */
export type CallerWorktreeFailure = 'mismatch' | 'unverified' | 'outside'

/** Resolves the worktree a CLI caller runs in: its terminal first, then (local only) its cwd. */
export async function resolveCallerWorktree<T>(
  context: CurrentWorktreeContextHints | undefined,
  lookup: CallerWorktreeLookup<T>
): Promise<{ ok: true; worktree: T } | { ok: false; reason: CallerWorktreeFailure }> {
  if (context?.terminalHandle) {
    const terminal = await lookup.showTerminal(context.terminalHandle).catch(() => null)
    if (terminal && context.worktreeId && context.worktreeId !== terminal.worktreeId) {
      return { ok: false, reason: 'mismatch' }
    }
    const worktree = terminal
      ? await lookup.worktreeById(terminal.worktreeId).catch(() => null)
      : null
    if (worktree) {
      return { ok: true, worktree }
    }
    if (context.remote === true || context.worktreeId) {
      return { ok: false, reason: 'unverified' }
    }
  }
  if (context?.remote !== true && context?.cwd) {
    const worktree = await lookup.worktreeForPath(context.cwd)
    if (worktree) {
      return { ok: true, worktree }
    }
  }
  return { ok: false, reason: 'outside' }
}
