import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { isAgentHookSource, type AgentHookSource } from '../shared/agent-hook-relay'
import { buildSpoolHookBody, type SpoolRecord } from '../shared/agent-hook-spool'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'

type ApplyRelayEvent = (
  event: AgentHookEventPayload,
  source: AgentHookSource,
  env?: string,
  version?: string,
  options?: { isReplay?: boolean }
) => void

export function ingestRelayAgentHookSpoolRecord(
  record: SpoolRecord,
  state: HookListenerState,
  env: string,
  applyEvent: ApplyRelayEvent
): void {
  if (!isAgentHookSource(record.source)) {
    return
  }
  const body = buildSpoolHookBody(record)
  const event = normalizeHookPayload(state, record.source, body, env, {
    deferCompactOwnershipToClient: true
  })
  if (!event) {
    return
  }
  applyEvent(event, record.source, hookBodyEnv(body), hookBodyVersion(body), { isReplay: true })
}
