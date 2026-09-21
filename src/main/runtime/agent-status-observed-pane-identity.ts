import {
  resolveAgentStatusBinding,
  type AgentStatusRuntimeEnrichment,
  type ObservedAgentStatusPaneIdentity
} from '../ipc/agent-status-ipc-boundary'

/** Bounded like the hook server's own per-pane maps; eviction only degrades a row to `unobserved`. */
const MAX_OBSERVED_PANES = 1024

const UNOBSERVED: ObservedAgentStatusPaneIdentity = { kind: 'unobserved' }

/**
 * The identity each pane was running under when a status row arrived.
 *
 * Why a record and not another lookup: the fleet snapshot remints every cached hook row on
 * every read, so a row observed under one process silently acquired whatever process, dispatch
 * and terminal the pane owns NOW. Incarnation equality in the matcher then agreed perfectly
 * while the evidence described a process that had already exited. Identity is a property of
 * the observation, so it has to be captured when the observation happens.
 */
export class AgentStatusObservedPaneIdentities {
  private readonly byPaneKey = new Map<string, ObservedAgentStatusPaneIdentity>()

  /** An unresolvable pane records nothing: not knowing the identity now is not evidence
   *  against the last identity this runtime did observe for the pane. */
  record(paneKey: string, identity: ObservedAgentStatusPaneIdentity): void {
    if (identity.kind === 'unobserved') {
      return
    }
    // Delete-then-set keeps insertion order most-recent, so eviction sheds the oldest pane.
    this.byPaneKey.delete(paneKey)
    this.byPaneKey.set(paneKey, identity)
    while (this.byPaneKey.size > MAX_OBSERVED_PANES) {
      const oldest = this.byPaneKey.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.byPaneKey.delete(oldest)
    }
  }

  read(paneKey: string): ObservedAgentStatusPaneIdentity {
    return this.byPaneKey.get(paneKey) ?? UNOBSERVED
  }
}

/** Ingest-time capture: resolve the pane once, as the status arrives, and keep that answer. */
export function recordObservedAgentStatusPaneIdentity(
  identities: AgentStatusObservedPaneIdentities,
  paneKey: string,
  runtime: AgentStatusRuntimeEnrichment | undefined
): void {
  const binding = resolveAgentStatusBinding(paneKey, runtime)
  identities.record(
    paneKey,
    binding.kind === 'unresolved'
      ? UNOBSERVED
      : {
          kind: 'observed',
          terminalHandle: binding.terminalHandle,
          processIncarnation: binding.processIncarnation,
          dispatchId: binding.kind === 'worker' ? binding.dispatchId : null
        }
  )
}
