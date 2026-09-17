import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentStatusIpcPayload } from '../shared/agent-status-types'
import {
  AgentStatusStorePublisher,
  type AgentStatusStorePublisherOptions,
  type AgentStatusStoreSourceMutation
} from '../shared/agent-status-store-publisher'

/** Delivery source for the relay's hook cache; it does not own status semantics. */
export class RelayAgentStatusStoreSource {
  private readonly receivedAtByPaneKey = new Map<string, number>()
  private readonly stateStartedAtByPaneKey = new Map<string, number>()
  private readonly listeners = new Set<(mutation: AgentStatusStoreSourceMutation) => void>()

  constructor(private readonly state: Pick<HookListenerState, 'lastStatusByPaneKey'>) {}

  createPublisher(
    options: Omit<AgentStatusStorePublisherOptions, 'source'>
  ): AgentStatusStorePublisher {
    return new AgentStatusStorePublisher({
      ...options,
      source: {
        getSnapshot: () => this.getSnapshot(),
        getRowsForPane: (paneKey) => this.getRowsForPane(paneKey),
        subscribeMutations: (listener) => {
          this.listeners.add(listener)
          return () => this.listeners.delete(listener)
        }
      }
    })
  }

  getSnapshot(): AgentStatusIpcPayload[] {
    return Array.from(this.state.lastStatusByPaneKey.values(), (event) => this.toStatusRow(event))
  }

  getRowsForPane(paneKey: string): AgentStatusIpcPayload[] {
    const event = this.state.lastStatusByPaneKey.get(paneKey)
    return event ? [this.toStatusRow(event)] : []
  }

  reset(): void {
    this.receivedAtByPaneKey.clear()
    this.stateStartedAtByPaneKey.clear()
    this.listeners.clear()
  }

  recordEvent(event: AgentHookEventPayload, previous: AgentHookEventPayload | undefined): void {
    const receivedAt = Math.max(Date.now(), (this.receivedAtByPaneKey.get(event.paneKey) ?? -1) + 1)
    this.receivedAtByPaneKey.set(event.paneKey, receivedAt)
    const stateStartedAt =
      previous && previous.payload.state === event.payload.state
        ? (this.stateStartedAtByPaneKey.get(event.paneKey) ?? receivedAt)
        : receivedAt
    this.stateStartedAtByPaneKey.set(event.paneKey, stateStartedAt)
    this.emit({
      before: previous ? { paneKey: event.paneKey } : null,
      after: { paneKey: event.paneKey }
    })
  }

  clearPane(paneKey: string, previous: AgentHookEventPayload | undefined): void {
    this.receivedAtByPaneKey.delete(paneKey)
    this.stateStartedAtByPaneKey.delete(paneKey)
    if (previous) {
      this.emit({ before: { paneKey }, after: null })
    }
  }

  private toStatusRow(event: AgentHookEventPayload): AgentStatusIpcPayload {
    const receivedAt = this.receivedAtByPaneKey.get(event.paneKey) ?? 0
    const stateStartedAt = this.stateStartedAtByPaneKey.get(event.paneKey) ?? receivedAt
    return {
      ...event.payload,
      paneKey: event.paneKey,
      ...(event.launchToken ? { launchToken: event.launchToken } : {}),
      ...(event.tabId ? { tabId: event.tabId } : {}),
      ...(event.worktreeId ? { worktreeId: event.worktreeId } : {}),
      connectionId: null,
      receivedAt,
      stateStartedAt,
      ...(event.providerSession ? { providerSession: event.providerSession } : {}),
      ...(event.providerSessionOnly ? { providerSessionOnly: true } : {})
    }
  }

  private emit(mutation: AgentStatusStoreSourceMutation): void {
    for (const listener of this.listeners) {
      try {
        listener(mutation)
      } catch (error) {
        process.stderr.write(
          `[relay-hook-server] status-row listener failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
      }
    }
  }
}
