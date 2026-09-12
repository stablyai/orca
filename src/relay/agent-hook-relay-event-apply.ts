import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import {
  isAgentHookSource,
  type AgentHookRelayEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import { buildSpoolHookBody, type SpoolRecord } from '../shared/agent-hook-spool'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { buildRelayHookEnvelope, hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import { evictCachedPanesOverCap } from './agent-hook-cached-pane-status'

export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void

export type RelayHookEventApplyHost = {
  state: HookListenerState
  lastEnvelopeMetaByPaneKey: Map<
    string,
    { source: AgentHookSource; env?: string; version?: string }
  >
  isPaneSurfaceRetired: (paneKey: string) => boolean
  clearPaneState: (paneKey: string) => void
  clearAssistantMessageRetry: (paneKey: string) => void
  forward: RelayHookForward
  env: string
}

export function applyRelayHookEvent(
  host: RelayHookEventApplyHost,
  event: AgentHookEventPayload,
  source: AgentHookSource,
  env?: string,
  version?: string,
  options: { isReplay?: boolean } = {}
): void {
  if (host.isPaneSurfaceRetired(event.paneKey)) {
    host.clearPaneState(event.paneKey)
    return
  }
  if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
    host.clearAssistantMessageRetry(event.paneKey)
  }
  host.state.lastStatusByPaneKey.delete(event.paneKey)
  host.state.lastStatusByPaneKey.set(event.paneKey, event)
  host.lastEnvelopeMetaByPaneKey.delete(event.paneKey)
  host.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
  evictCachedPanesOverCap(host.state.lastStatusByPaneKey, (key) => host.clearPaneState(key))
  host.forward(buildRelayHookEnvelope(event, source, env, version, options))
}

export function ingestRelaySpoolRecord(host: RelayHookEventApplyHost, record: SpoolRecord): void {
  if (!isAgentHookSource(record.source)) {
    return
  }
  const body = buildSpoolHookBody(record)
  const event = normalizeHookPayload(host.state, record.source, body, host.env, {
    deferCompactOwnershipToClient: true
  })
  if (!event) {
    return
  }
  applyRelayHookEvent(host, event, record.source, hookBodyEnv(body), hookBodyVersion(body), {
    isReplay: true
  })
}

export function forwardSessionStartClear(
  host: RelayHookEventApplyHost,
  previous: AgentHookEventPayload,
  env?: string,
  version?: string
): void {
  if (previous.hookEventName === 'SessionStart') {
    // Why: normalization removes the prior Codex status before returning null;
    // restore its tombstone so duplicate hooks neither rebroadcast nor erase replay.
    host.state.lastStatusByPaneKey.set(previous.paneKey, previous)
    return
  }
  host.clearAssistantMessageRetry(previous.paneKey)
  const providerSession = host.state.lastProviderSessionByPaneKey.get(previous.paneKey)
  // Why: do not publish state:done. Current completion-reactive consumers treat
  // plain done as a finished turn unless sessionBoundary is set
  // (agent-completion-hook-observer, automation-dispatch-completion,
  // agent-completion-time). sessionBoundary is Rule 1 optional — old mains
  // ignore it and still complete. New main clears on hookEventName SessionStart
  // and never applies this payload. Old main applies it as working, which is
  // today's SessionStart mapping, not a new completed-turn signal.
  // Compatibility limit: old main cannot receive a SessionStart clear without
  // applying some status; we refuse a false completion over a stale working row.
  applyRelayHookEvent(
    host,
    {
      ...previous,
      hookEventName: 'SessionStart',
      ...(providerSession ? { providerSession } : {}),
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    },
    'codex',
    env,
    version
  )
}
