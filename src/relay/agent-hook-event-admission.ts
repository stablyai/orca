import { transitionHookPresence } from '../shared/agent-hook-presence-transition'
import { isSameAgentProcess } from '../shared/agent-process-presence'
import { cacheRelayLegacyAgentStatus } from '../shared/agent-status-legacy-relay-cache'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import type { RelayHookForward } from './agent-hook-server-contract'
import { MAX_CACHED_PANES, type CachedPaneEnvelopeMeta } from './agent-hook-cached-pane-status'
import {
  reconcileRelayClaudeCancel,
  withRelayClaudeTurnRevision
} from './agent-hook-interrupt-reconciliation'

type RelayHookAdmissionHost = {
  state: HookListenerState
  metadata: Map<string, CachedPaneEnvelopeMeta>
  isCanonicalPane: (paneKey: string) => boolean
  isPaneSurfaceRetired: (paneKey: string) => boolean
  clearPaneState: (paneKey: string) => void
  clearAssistantMessageRetry: (paneKey: string) => void
  forward: RelayHookForward
  checkAgentPresence: (paneKey: string) => Promise<void>
}

export function applyRelayHookEvent(
  host: RelayHookAdmissionHost,
  incoming: AgentHookEventPayload,
  source: AgentHookSource,
  env?: string,
  version?: string,
  options: { isReplay?: boolean; checkPresence?: boolean } = {}
): AgentHookEventPayload | undefined {
  if (host.isCanonicalPane(incoming.paneKey)) {
    return undefined
  }
  const previous = host.state.lastStatusByPaneKey.get(incoming.paneKey)
  const cancellation = reconcileRelayClaudeCancel(host.state, previous, incoming, source)
  if (cancellation.hold) {
    return previous
  }
  const transitioned = transitionHookPresence(cancellation.event, previous)
  if (!transitioned) {
    return undefined
  }
  const event = withRelayClaudeTurnRevision(
    previous,
    transitioned.agentPresence?.ended
      ? { ...transitioned, providerSessionOnly: true }
      : transitioned,
    source
  )
  // Why: this post came from a process still running inside a pane whose tab the user closed.
  // Caching or forwarding it makes every connected client advertise a live, resumable agent pane
  // that no tab owns — the advertisement that ends up auto-typing a second `--resume` onto a
  // transcript the orphan is still writing (#12447). Drop the stale cache with it.
  if (host.isPaneSurfaceRetired(event.paneKey)) {
    host.clearPaneState(event.paneKey)
    return undefined
  }
  if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
    host.clearAssistantMessageRetry(event.paneKey)
  }
  // Why: keep PostCompact identity in the replay cache so the client can re-run ownership when
  // it reconnects. Stripping it would let a cold relay replay a completion as an ordinary `done`
  // row and resurrect a pane that the client had already retired.
  if (
    !cacheRelayLegacyAgentStatus(host.state, event, MAX_CACHED_PANES, (paneKey) =>
      host.clearPaneState(paneKey)
    )
  ) {
    return undefined
  }
  host.metadata.delete(event.paneKey)
  host.metadata.set(event.paneKey, { source, env, version })
  host.forward(buildRelayHookEnvelope(event, source, env, version, options))
  const sender = incoming.agentPresence?.process
  const owner = event.agentPresence
  // Why: a live hook proves its own process alive; only another process's hook casts doubt on the owner.
  if (
    options.checkPresence !== false &&
    sender &&
    owner?.process &&
    !owner.ended &&
    !isSameAgentProcess(sender, owner.process)
  ) {
    void host.checkAgentPresence(event.paneKey)
  }
  // Why: retries compare against the cached row by identity, so they must hold that exact row.
  return host.state.lastStatusByPaneKey.get(event.paneKey)
}
