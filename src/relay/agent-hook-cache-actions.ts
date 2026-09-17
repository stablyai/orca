import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import {
  isAgentHookSource,
  type AgentHookRelayEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import { buildSpoolHookBody, type SpoolRecord } from '../shared/agent-hook-spool'
import { buildRelayHookEnvelope, hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import { selectReplayableCachedPanes } from './agent-hook-cached-pane-status'

export function replayCachedRelayPayloads(options: {
  cachedByPaneKey: ReadonlyMap<string, AgentHookEventPayload>
  metaByPaneKey: ReadonlyMap<string, { source: AgentHookSource; env?: string; version?: string }>
  isPaneSurfaceRetired: (paneKey: string) => boolean
  dropPane: (paneKey: string) => void
  forward: (envelope: AgentHookRelayEnvelope) => void
}): number {
  const replayable = selectReplayableCachedPanes(options)
  for (const { event, meta } of replayable) {
    options.forward(
      buildRelayHookEnvelope(event, meta.source, meta.env, meta.version, { isReplay: true })
    )
  }
  return replayable.length
}

export function ingestRelaySpoolRecord(options: {
  record: SpoolRecord
  state: HookListenerState
  env: string
  applyEvent: (
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options?: { isReplay?: boolean }
  ) => void
}): void {
  const { record } = options
  if (!isAgentHookSource(record.source)) {
    return
  }
  const body = buildSpoolHookBody(record)
  const event = normalizeHookPayload(options.state, record.source, body, options.env, {
    deferCompactOwnershipToClient: true
  })
  if (!event) {
    return
  }
  options.applyEvent(event, record.source, hookBodyEnv(body), hookBodyVersion(body), {
    isReplay: true
  })
}
