import { useEffect, useRef } from 'react'
import { isSyntheticWorkspaceRoute } from './synthetic-workspace-route'
import type { WorktreeShowResolution } from '../worktree/worktree-show-resolution'

export function shouldBounceMissingWorktree(
  worktreeId: string,
  resolution: WorktreeShowResolution
): boolean {
  return resolution === 'missing' && !isSyntheticWorkspaceRoute(worktreeId)
}

// Bounce only after proven deletion so stale links cannot strand the session screen or transient failures eject it.
export function useMissingWorktreeBounce(args: {
  hostId: string
  worktreeId: string
  resolution: WorktreeShowResolution
  bounce: (hostId: string) => void
}): void {
  const { hostId, worktreeId, resolution } = args
  // Latch before navigation takes effect so intervening renders cannot bounce repeatedly.
  const bouncedRef = useRef<string | null>(null)
  const bounceRef = useRef(args.bounce)
  // Sync the callback before the bounce effect so it sees the newest closure without mutating refs during render.
  useEffect(() => {
    bounceRef.current = args.bounce
  })
  useEffect(() => {
    if (!hostId || bouncedRef.current === worktreeId) {
      return
    }
    if (!shouldBounceMissingWorktree(worktreeId, resolution)) {
      return
    }
    bouncedRef.current = worktreeId
    bounceRef.current(hostId)
  }, [hostId, worktreeId, resolution])
}
