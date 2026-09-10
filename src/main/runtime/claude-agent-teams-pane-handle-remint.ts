import type { AgentTeam, AgentTeamsTerminalApi, TeamPane } from './claude-agent-teams-types'

function isStaleTerminalHandleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('terminal_handle_stale') || message.includes('terminal_gone')
}

// Why: teams outlive remintable terminal handles (the leader handle is snapshotted at
// launch), so recover a stale handle via the pane key and retry once instead of
// failing every teammate operation for the rest of the session.
export async function withFreshPaneHandle<T>(
  team: AgentTeam,
  pane: TeamPane,
  api: AgentTeamsTerminalApi,
  operation: (handle: string) => Promise<T>
): Promise<T> {
  // Why: capture the attempted handle — a concurrent caller may remint pane.handle
  // between our failure and the retry check, and comparing against the shared
  // mutable field would wrongly skip the retry for the loser of that race.
  const attempted = pane.handle
  try {
    return await operation(attempted)
  } catch (error) {
    if (!isStaleTerminalHandleError(error) || !pane.paneKey) {
      throw error
    }
    const fresh = api.resolveTerminalHandleForPaneKey?.(pane.paneKey)
    if (!fresh) {
      throw error
    }
    // Why: retry even when the resolver returns the attempted handle — resolving by
    // pane key re-registers that handle against the current renderer epoch as a side
    // effect, so epoch-only staleness is already healed for the retry.
    pane.handle = fresh
    if (pane.fakePaneId === team.leaderPane) {
      team.leaderHandle = fresh
    }
    return await operation(fresh)
  }
}
