import { useEffect, useRef } from 'react'
import { isSyntheticWorkspaceRoute } from './synthetic-workspace-route'
import type { WorktreeShowResolution } from '../worktree/worktree-show-resolution'

export function shouldBounceMissingWorktree(
  worktreeId: string,
  resolution: WorktreeShowResolution
): boolean {
  return resolution === 'missing' && !isSyntheticWorkspaceRoute(worktreeId)
}

/** Sends the route back to the host index once the host has *proven* the worktree is gone —
 *  a workspace deleted on the desktop while the phone held the link (Resume, a notification,
 *  a cold deep link) otherwise lands on a session screen whose every RPC fails. */
export function useMissingWorktreeBounce(args: {
  hostId: string
  worktreeId: string
  resolution: WorktreeShowResolution
  bounce: (hostId: string) => void
}): void {
  const { hostId, worktreeId, resolution } = args
  // Why: navigation takes effect after this render, so without a latch the renders before
  // unmount would each fire again — and it lets callers pass an inline bounce closure.
  const bouncedRef = useRef<string | null>(null)
  const bounceRef = useRef(args.bounce)
  // Why: synced in an effect (render must stay pure); declared first so the
  // bounce effect below always sees the freshest closure in the same commit.
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
