import type { MobileWorktreeForkMode } from '../mobile-structured-chat-worktree-fork'
import { useEffect, useSyncExternalStore } from 'react'

// The header's "…" menu sits outside the chat's fork provider; it asks the provider instead.
let pending: MobileWorktreeForkMode | null = null
let version = 0
const listeners = new Set<() => void>()

/** Lets the open chat's fork provider hear a request. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Forks the open chat into a new worktree, from its newest response. */
export function requestMobileWorktreeFork(mode: MobileWorktreeForkMode = 'worktree'): void {
  // With no chat showing, a kept request would fork whichever chat opens next.
  if (listeners.size === 0) {
    return
  }
  pending = mode
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/** Hands the provider a pending request; `forkLatest` reports whether a response could fork. */
export function useMobileWorktreeForkRequest(
  forkLatest: (mode: MobileWorktreeForkMode) => boolean,
  onNothing: () => void
): void {
  const current = useSyncExternalStore(subscribe, () => version)
  useEffect(() => {
    const mode = pending
    if (!mode) {
      return
    }
    pending = null
    if (!forkLatest(mode)) {
      onNothing()
    }
  }, [current, forkLatest, onNothing])
}
