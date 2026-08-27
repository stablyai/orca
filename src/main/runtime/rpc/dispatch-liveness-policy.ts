export const WORKTREE_REMOVE_KEEPALIVE_MAX_MS = 5 * 60_000

export function boundedDispatchKeepaliveMs(
  method: string,
  worktreeRemoveMaxMs = WORKTREE_REMOVE_KEEPALIVE_MAX_MS
): number | null {
  return method === 'worktree.rm' ? worktreeRemoveMaxMs : null
}
