import type { CurrentWorktreeContextHints } from '../shared/current-worktree-context'

export function buildCurrentWorktreeContext(
  cwd: string,
  remote: boolean
): CurrentWorktreeContextHints {
  return {
    remote,
    ...(remote ? {} : { cwd }),
    ...(process.env.ORCA_WORKTREE_ID ? { worktreeId: process.env.ORCA_WORKTREE_ID } : {}),
    ...(process.env.ORCA_TERMINAL_HANDLE
      ? { terminalHandle: process.env.ORCA_TERMINAL_HANDLE }
      : {})
  }
}
