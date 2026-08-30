import { applyRelayHookEvent } from './agent-hook-status-cache'
import { reconcileRelayCodexEvent } from './agent-hook-codex-reconciliation'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource, AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'

export function applyRelayEvent(options: {
  state: HookListenerState
  event: AgentHookEventPayload
  source: AgentHookSource
  env?: string
  version?: string
  receivedAt?: number
  isReplay?: boolean
  metadata: Map<string, { source: AgentHookSource; env?: string; version?: string }>
  persist: () => void
  clearPaneState: (paneKey: string) => void
  forward: (envelope: AgentHookRelayEnvelope) => void
  scheduleCodexReconciliation: (paneKey: string) => void
  scheduleCodexRestartReconciliation: (paneKey: string) => void
  clearAssistantMessageRetry: (paneKey: string) => void
  isPaneSurfaceRetired: (paneKey: string) => boolean
}): void {
  // Why: this post came from a process still running inside a pane whose tab the user closed.
  // Caching or forwarding it makes every connected client advertise a live, resumable agent pane
  // that no tab owns — the advertisement that ends up auto-typing a second `--resume` onto a
  // transcript the orphan is still writing (#12447). Drop the stale cache with it.
  if (options.isPaneSurfaceRetired(options.event.paneKey)) {
    options.clearPaneState(options.event.paneKey)
    return
  }
  if (options.event.payload.state !== 'done' || options.event.payload.lastAssistantMessage) {
    options.clearAssistantMessageRetry(options.event.paneKey)
  }
  const previous = options.state.lastStatusByPaneKey.get(options.event.paneKey)
  const diagnosticAware =
    options.event.reconcileDiagnostic === undefined && previous?.reconcileDiagnostic !== undefined
      ? { ...options.event, reconcileDiagnostic: previous.reconcileDiagnostic }
      : options.event
  const reconciled =
    diagnosticAware.payload.agentType === 'codex'
      ? reconcileRelayCodexEvent(options.state, diagnosticAware)
      : diagnosticAware
  applyRelayHookEvent({
    state: options.state,
    event: reconciled,
    previous,
    source: options.source,
    env: options.env,
    version: options.version,
    receivedAt: options.receivedAt,
    metadata: options.metadata,
    persist: options.persist,
    clearPaneState: options.clearPaneState,
    forward: (envelope) =>
      options.forward(options.isReplay ? { ...envelope, isReplay: true } : envelope)
  })
  if (reconciled.payload.agentType === 'codex') {
    const schedule = options.isReplay
      ? options.scheduleCodexRestartReconciliation
      : options.scheduleCodexReconciliation
    schedule(reconciled.paneKey)
  }
}
