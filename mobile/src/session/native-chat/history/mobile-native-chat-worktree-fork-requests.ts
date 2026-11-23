import type { MobileWorktreeForkMode } from '../../mobile-structured-chat-worktree-fork'
import { useEffect, useSyncExternalStore } from 'react'

/** The chat screen a request is for; a screen kept mounted under another must not take it. */
export type MobileWorktreeForkRequestTarget = { hostId: string; worktreeId: string }

// The header's "…" menu sits outside the chat's fork provider; it asks the provider instead.
let pending: (MobileWorktreeForkRequestTarget & { mode: MobileWorktreeForkMode }) | null = null
let version = 0
const listeners = new Set<() => void>()

/** Lets the open chat's fork provider hear a request. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Forks the target's open chat into a new worktree, from its newest response. */
export function requestMobileWorktreeFork(
  target: MobileWorktreeForkRequestTarget,
  mode: MobileWorktreeForkMode = 'worktree'
): void {
  // With no chat showing, a kept request would fork whichever chat opens next.
  if (listeners.size === 0) {
    return
  }
  pending = { ...target, mode }
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/** Hands the provider of `target` its pending request; `forkLatest` reports whether a response
 *  could fork. */
export function useMobileWorktreeForkRequest(
  target: MobileWorktreeForkRequestTarget,
  forkLatest: (mode: MobileWorktreeForkMode) => boolean,
  onNothing: () => void
): void {
  const current = useSyncExternalStore(subscribe, () => version)
  const { hostId, worktreeId } = target
  useEffect(() => {
    const request = pending
    if (!request || request.hostId !== hostId || request.worktreeId !== worktreeId) {
      return
    }
    pending = null
    if (!forkLatest(request.mode)) {
      onNothing()
    }
  }, [current, forkLatest, hostId, onNothing, worktreeId])
}
