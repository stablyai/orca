import type { AgentHookProviderSessionIdentity } from './server'

type KnownSession = { sessionId: string; worktreeId: string }

/** Tracks hook-reported provider sessions across status events and names the
 *  worktrees whose set just changed.
 *
 *  Why this exists: on headless `orca serve` there is no renderer to publish
 *  `tab.agentStatus`, so the hook row is the only carrier of a pane's provider
 *  session — and a phone already subscribed to `session.tabs` is not polled while
 *  its stream is healthy. Without a push, native chat sits on `waiting-session`
 *  until some unrelated tab event happens to re-run the projection.
 *
 *  Only provider-session transitions are reported: every other hook field already
 *  reaches mobile through paths that notify, and invalidating on each status ping
 *  would re-project the whole workspace on every tool call. */
export function createHookProviderSessionInvalidator(): (
  identities: readonly AgentHookProviderSessionIdentity[]
) => string[] {
  let known = new Map<string, KnownSession>()
  return (identities) => {
    const next = new Map<string, KnownSession>()
    const changedWorktrees = new Set<string>()
    for (const identity of identities) {
      if (!identity.worktreeId) {
        continue
      }
      next.set(identity.paneKey, {
        sessionId: identity.sessionId,
        worktreeId: identity.worktreeId
      })
      if (known.get(identity.paneKey)?.sessionId !== identity.sessionId) {
        changedWorktrees.add(identity.worktreeId)
      }
    }
    // A pane whose session went away (agent exited, row evicted) is a change too:
    // native chat must stop offering a transcript that is no longer addressable.
    for (const [paneKey, previous] of known) {
      if (!next.has(paneKey)) {
        changedWorktrees.add(previous.worktreeId)
      }
    }
    known = next
    return [...changedWorktrees]
  }
}
