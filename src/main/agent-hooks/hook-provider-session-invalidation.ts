import type { AgentHookProviderSessionIdentity } from './server'

type KnownSession = { sessionId: string; transcriptPath?: string; worktreeId: string }

/** Names worktrees whose hook-reported resume identity changed. */
export function createHookProviderSessionInvalidator(): (
  identities: readonly AgentHookProviderSessionIdentity[]
) => string[] {
  let known = new Map<string, KnownSession>()
  return (identities) => {
    const next = new Map<string, KnownSession>()
    const changedWorktrees = new Set<string>()
    for (const identity of identities) {
      const previous = known.get(identity.paneKey)
      const worktreeId = identity.worktreeId ?? previous?.worktreeId
      if (!worktreeId) {
        continue
      }
      next.set(identity.paneKey, {
        sessionId: identity.sessionId,
        ...(identity.transcriptPath ? { transcriptPath: identity.transcriptPath } : {}),
        worktreeId
      })
      if (
        previous?.sessionId !== identity.sessionId ||
        previous?.transcriptPath !== identity.transcriptPath ||
        previous?.worktreeId !== worktreeId
      ) {
        if (previous?.worktreeId !== worktreeId) {
          changedWorktrees.add(previous?.worktreeId ?? worktreeId)
        }
        changedWorktrees.add(worktreeId)
      }
    }
    for (const [paneKey, previous] of known) {
      if (!next.has(paneKey)) {
        changedWorktrees.add(previous.worktreeId)
      }
    }
    known = next
    return [...changedWorktrees]
  }
}
