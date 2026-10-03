import { transitionHookPresence } from '../shared/agent-hook-presence-transition'
import type { RelayAgentPresence } from './relay-agent-presence'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import type { RelayHookForward } from './agent-hook-server-options'
import type { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { cacheRelayLegacyAgentStatus } from '../shared/agent-status-legacy-relay-cache'
import { MAX_CACHED_PANES } from './agent-hook-cached-pane-status'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import {
  agentRunEvidence,
  type AgentRunEvidence
} from '../shared/agent-presence-command-observer'

type RelayEventHost = {
  state: HookListenerState
  observePresence: (event: AgentHookEventPayload) => AgentHookEventPayload
  isPaneSurfaceRetired: (paneKey: string) => boolean
  clearPaneState: (paneKey: string) => void
  retryScheduler: AgentHookResultRetryScheduler
  lastEnvelopeMetaByPaneKey: Map<
    string,
    { source?: AgentHookSource; env?: string; version?: string }
  >
  forward: RelayHookForward
  presenceChecks: RelayAgentPresence
  onAgentEvidence?: (paneKey: string, agent: string, run: AgentRunEvidence) => void
}
export type RelayEventOptions = {
  isReplay?: boolean
  checkPresence?: boolean
  hostPresence?: boolean
}

/** Mirrors the desktop's claim rule so a reconnect replay cannot bring the ended turn back. */
function settleExitClaimInCache(
  host: RelayEventHost,
  claim: AgentHookEventPayload,
  cached: AgentHookEventPayload | undefined
): void {
  if (
    !cached ||
    cached.providerSessionOnly ||
    cached.payload.agentType !== claim.agentPresence?.agent ||
    !claim.providerSession ||
    cached.providerSession?.id !== claim.providerSession.id
  ) {
    return
  }
  const { launchToken: _launchToken, ...resumeIdentity } = cached
  if (
    !cacheRelayLegacyAgentStatus(
      host.state,
      { ...resumeIdentity, providerSessionOnly: true },
      MAX_CACHED_PANES,
      (paneKey) => host.clearPaneState(paneKey)
    )
  ) {
    host.clearPaneState(claim.paneKey)
  }
}

export function applyRelayAgentEvent(
  host: RelayEventHost,
  incoming: AgentHookEventPayload,
  source: AgentHookSource | undefined,
  env: string | undefined,
  version: string | undefined,
  options: RelayEventOptions
): AgentHookEventPayload | undefined {
  const meta =
    options.hostPresence && !incoming.providerSessionOnly
      ? host.lastEnvelopeMetaByPaneKey.get(incoming.paneKey)
      : undefined
  source ??= meta?.source
  env ??= meta?.env
  version ??= meta?.version
  const cached = host.state.lastStatusByPaneKey.get(incoming.paneKey)
  // Why: an exit claim is never a row here either. A live owner is checked; otherwise the desktop
  // decides it against its own turn, and the replay cache settles the same way.
  if (!options.hostPresence && incoming.agentPresence?.ended && !incoming.agentPresence.process) {
    if (cached?.agentPresence?.process && !cached.agentPresence.ended) {
      void host.presenceChecks.observeHook(incoming, cached, true)
    } else if (!host.isPaneSurfaceRetired(incoming.paneKey)) {
      settleExitClaimInCache(host, incoming, cached)
      host.forward(buildRelayHookEnvelope(incoming, source, env, version, options))
    }
    return undefined
  }
  const transitioned = options.hostPresence ? incoming : transitionHookPresence(incoming, cached)
  if (!transitioned) {
    return undefined
  }
  const event = host.observePresence(transitioned)
  // Why: this post came from a process still running inside a pane whose tab the user closed.
  // Caching or forwarding it makes every connected client advertise a live, resumable agent pane
  // that no tab owns — the advertisement that ends up auto-typing a second `--resume` onto a
  // transcript the orphan is still writing (#12447). Drop the stale cache with it.
  if (host.isPaneSurfaceRetired(event.paneKey)) {
    host.clearPaneState(event.paneKey)
    return undefined
  }
  if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
    host.retryScheduler.clearAssistantMessageRetry(event.paneKey)
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
  host.lastEnvelopeMetaByPaneKey.delete(event.paneKey)
  host.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
  host.forward(
    buildRelayHookEnvelope(
      // Why without resume identity: an owner observation must reach the owner path only, never
      // pass as a Pi session row on the turn path.
      options.hostPresence
        ? { ...event, providerSession: undefined, providerSessionOnly: true }
        : event,
      source,
      env,
      version,
      { isReplay: options.isReplay }
    )
  )
  const evidenceAgent = event.payload.agentType ?? 'unknown'
  const run = agentRunEvidence(incoming)
  const check = host.presenceChecks.observeHook(
    incoming,
    event,
    !options.hostPresence && options.checkPresence !== false
  )
  if (check) {
    void check.then(() => host.onAgentEvidence?.(event.paneKey, evidenceAgent, run))
  } else if (!options.hostPresence && options.checkPresence !== false) {
    host.onAgentEvidence?.(event.paneKey, evidenceAgent, run)
  }
  // Why: retries compare against the cached row by identity, so they must hold that exact row.
  return host.state.lastStatusByPaneKey.get(event.paneKey)
}
