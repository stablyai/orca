import type { AgentHookSource } from '../../shared/agent-hook-relay'

export type AgentSessionPaneBinding = {
  paneKey: string
  /** The PTY whose spawn established this binding; the binding dies with it. */
  ptyId: string
  /** Why carried: the inherited env names the DAEMON's workspace too, so a
   * corrected event would otherwise keep filing itself under the wrong one. */
  worktreeId?: string
}

// Why: one entry per pinned session. Generous headroom over any realistic live
// count while still bounding a caller that leaks registrations.
const MAX_BINDINGS = 512

/**
 * Maps a provider session id to the pane Orca spawned it into.
 *
 * Why this layer exists: a pane's identity reaches an agent's hooks only
 * through `ORCA_PANE_KEY` in the process environment, and a CLI that hosts
 * sessions inside a shared prewarmed daemon runs its hooks in a worker that
 * inherited the DAEMON's env — whichever pane happened to start the daemon,
 * possibly days ago in another workspace. The posted pane key is then simply
 * wrong, and the hook payload carries no other pane coordinate, so no
 * listener-side heuristic can recover the right one. The binding is therefore
 * established where Orca still knows both halves — at spawn, where it mints the
 * session id and owns the pane — and consulted at ingest.
 *
 * Session-scoped rather than process-scoped on purpose: the daemon's worker is
 * not the pane's PTY and can outlive it, so process ancestry proves nothing.
 * Transport-agnostic for the same reason — a remote host's daemon inherits a
 * stale key exactly like a local one, and both ingest seams resolve here.
 */
export class AgentSessionPaneBindings {
  private bindings = new Map<string, AgentSessionPaneBinding>()

  private static key(source: AgentHookSource, sessionId: string): string {
    // Why: source-scoped so two CLIs cannot collide on a shared id namespace.
    return `${source}\u0000${sessionId}`
  }

  bind(source: AgentHookSource, sessionId: string, binding: AgentSessionPaneBinding): void {
    const sessionKey = sessionId.trim()
    if (!sessionKey || !binding.paneKey || !binding.ptyId) {
      return
    }
    const key = AgentSessionPaneBindings.key(source, sessionKey)
    // Why: delete first so re-binding an existing session moves it to the end
    // of the insertion order — eviction stays least-recently-bound.
    this.bindings.delete(key)
    this.bindings.set(key, binding)
    while (this.bindings.size > MAX_BINDINGS) {
      const oldest = this.bindings.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.bindings.delete(oldest)
    }
  }

  resolve(
    source: AgentHookSource,
    sessionId: string | null | undefined
  ): AgentSessionPaneBinding | null {
    if (!sessionId) {
      return null
    }
    return this.bindings.get(AgentSessionPaneBindings.key(source, sessionId.trim())) ?? null
  }

  /** Drops every binding a dying PTY established, so a reused id space cannot
   * re-route a later session onto a pane that no longer runs it. */
  clearForPty(ptyId: string): void {
    for (const [key, binding] of this.bindings) {
      if (binding.ptyId === ptyId) {
        this.bindings.delete(key)
      }
    }
  }

  size(): number {
    return this.bindings.size
  }
}
