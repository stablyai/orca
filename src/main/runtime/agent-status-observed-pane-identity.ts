import {
  resolveAgentStatusBinding,
  type AgentStatusRuntimeEnrichment,
  type ObservedAgentStatusPaneIdentity
} from '../ipc/agent-status-ipc-boundary'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { OrcaRuntimeService } from './orca-runtime'

type ObservedStatusRuntime = AgentStatusRuntimeEnrichment &
  Partial<Pick<OrcaRuntimeService, 'recordCliWriterConversation'>>

/** Bounded like the hook server's own per-pane maps; eviction only degrades a row to `unobserved`. */
const MAX_OBSERVED_PANES = 1024

const UNOBSERVED: ObservedAgentStatusPaneIdentity = { kind: 'unobserved' }

/** Capture identity at observation: later fleet snapshots must not reattribute old rows to a new process/dispatch. */
export class AgentStatusObservedPaneIdentities {
  private readonly byPaneKey = new Map<string, ObservedAgentStatusPaneIdentity>()

  /** Unknown identity cannot invalidate the last observed identity. */
  record(paneKey: string, identity: ObservedAgentStatusPaneIdentity): void {
    if (identity.kind === 'unobserved') {
      return
    }
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

/** Buffers startup replay until PTY recovery has restored the runtime identities it fences. */
export class AgentStatusObservedPaneIdentityCapture {
  private readonly pending = new Map<string, EnrichedAgentHookEventPayload>()
  private runtime: ObservedStatusRuntime | null = null

  constructor(private readonly identities: AgentStatusObservedPaneIdentities) {}

  observe(enriched: EnrichedAgentHookEventPayload): void {
    if (this.runtime) {
      recordObservedAgentStatusPaneIdentity(this.identities, enriched, this.runtime)
      return
    }
    this.pending.set(enriched.paneKey, enriched)
  }

  attach(runtime: ObservedStatusRuntime): void {
    this.runtime = runtime
    for (const enriched of this.pending.values()) {
      recordObservedAgentStatusPaneIdentity(this.identities, enriched, runtime)
    }
    this.pending.clear()
  }
}

export function recordObservedAgentStatusPaneIdentity(
  identities: AgentStatusObservedPaneIdentities,
  event: EnrichedAgentHookEventPayload,
  runtime: ObservedStatusRuntime | undefined
): void {
  runtime?.recordCliWriterConversation?.(event)
  const binding = resolveAgentStatusBinding(event.paneKey, runtime)
  identities.record(
    event.paneKey,
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
