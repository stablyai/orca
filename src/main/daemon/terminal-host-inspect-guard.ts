// Missing-session guard for `TerminalHost.inspectProcess`.
//
// Split out of `terminal-host.ts` because that module sits at the 300-line budget
// and the max-lines ratchet requires new growth to move into a sibling rather than
// take a bypass.

import type { RetiredPtyIncarnation } from '../../shared/retired-pty-incarnations'
import { pruneRetiredPtyIncarnations } from '../../shared/retired-pty-incarnations'
import { SessionNotFoundError } from './daemon-errors'

// Preserves the historical SYNCHRONOUS missing-session failure: a caller that
// names a dead session gets a throw, not a rejected promise. A retired
// incarnation still answers, but only while its grace window is open and only
// for the exact incarnation the caller expected.
export function assertInspectableSession(args: {
  sessionId: string
  isAlive: boolean
  retiredIncarnations: Map<string, RetiredPtyIncarnation>
  expectedIncarnationId: string | undefined
}): void {
  pruneRetiredPtyIncarnations(args.retiredIncarnations)
  if (args.isAlive) {
    return
  }
  const retired = args.retiredIncarnations.get(args.sessionId)
  const withinGrace = (retired?.expiresAt ?? 0) > Date.now()
  if (!withinGrace || args.expectedIncarnationId !== retired?.incarnationId) {
    throw new SessionNotFoundError(args.sessionId)
  }
}
