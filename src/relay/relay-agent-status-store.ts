import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import type { AgentStatusIpcPayload } from '../shared/agent-status-types'
import { AgentStatusStorePublisher } from '../shared/agent-status-store-publisher'
import type {
  AgentStatusStorePublisherOptions,
  AgentStatusStoreSourceMutation
} from '../shared/agent-status-store-publisher'

function toStatusRow(envelope: AgentHookRelayEnvelope, receivedAt: number): AgentStatusIpcPayload {
  return {
    ...envelope.payload,
    paneKey: envelope.paneKey,
    ...(envelope.launchToken ? { launchToken: envelope.launchToken } : {}),
    ...(envelope.tabId ? { tabId: envelope.tabId } : {}),
    ...(envelope.worktreeId ? { worktreeId: envelope.worktreeId } : {}),
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    ...(envelope.providerSession ? { providerSession: envelope.providerSession } : {}),
    ...(envelope.providerSessionOnly ? { providerSessionOnly: true } : {})
  }
}

/** Relay-local projection fed by normalized hook envelopes; it owns delivery ordering only. */
export class RelayAgentStatusStore {
  private readonly rows = new Map<string, AgentStatusIpcPayload>()
  private readonly mutations = new Set<(mutation: AgentStatusStoreSourceMutation) => void>()
  private readonly receivedAtByPaneKey = new Map<string, number>()

  apply(envelope: AgentHookRelayEnvelope): void {
    const previous = this.rows.get(envelope.paneKey)
    const receivedAt = Math.max(
      Date.now(),
      (this.receivedAtByPaneKey.get(envelope.paneKey) ?? -1) + 1
    )
    this.receivedAtByPaneKey.set(envelope.paneKey, receivedAt)
    this.rows.set(envelope.paneKey, toStatusRow(envelope, receivedAt))
    this.emit({
      before: previous ? { paneKey: previous.paneKey } : null,
      after: { paneKey: envelope.paneKey }
    })
  }

  drop(paneKey: string): void {
    if (!this.rows.delete(paneKey)) {
      return
    }
    this.receivedAtByPaneKey.delete(paneKey)
    this.emit({ before: { paneKey }, after: null })
  }

  createPublisher(
    options: Omit<AgentStatusStorePublisherOptions, 'source'>
  ): AgentStatusStorePublisher {
    return new AgentStatusStorePublisher({
      ...options,
      source: {
        getSnapshot: () => [...this.rows.values()],
        getRowsForPane: (paneKey) => {
          const row = this.rows.get(paneKey)
          return row ? [row] : []
        },
        subscribeMutations: (listener) => {
          this.mutations.add(listener)
          return () => this.mutations.delete(listener)
        }
      }
    })
  }

  private emit(mutation: AgentStatusStoreSourceMutation): void {
    for (const listener of this.mutations) {
      try {
        listener(mutation)
      } catch (error) {
        process.stderr.write(
          `[relay-agent-status] mutation listener failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
      }
    }
  }
}
