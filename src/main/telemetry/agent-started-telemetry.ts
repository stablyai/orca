// Single builder for the `agent_started` attribution fields, shared by both PTY
// emitters (the runtime-owned CLI/create controller spawn and the renderer
// `pty:spawn` handler). Oracle 17: agent_kind + used_custom_agent are host-
// derived from the validated launch snapshot/receipt on a resolved launch — the
// caller overwrites the client-threaded values before spawn, so a spoofed client
// `agent_kind` never reaches the wire. launch_source/request_kind stay surface-
// owned. The event carries NO id/label/command/argv/env/path (the `.strict()`
// schema is the enforcement point); this marker is the only custom-launch signal.

import {
  agentKindSchema,
  launchSourceSchema,
  requestKindSchema
} from '../../shared/telemetry-events'
import type { EventProps } from '../../shared/telemetry-events'

/** The emit input threaded through the spawn args. Loosely typed because it
 *  crosses the IPC/controller boundary; every field is re-validated here. */
export type AgentStartedTelemetryInput = {
  agent_kind?: unknown
  launch_source?: unknown
  request_kind?: unknown
  used_custom_agent?: unknown
}

type AgentStartedAttribution = Pick<
  EventProps<'agent_started'>,
  'agent_kind' | 'launch_source' | 'request_kind' | 'used_custom_agent'
>

/** Validate the threaded telemetry into the closed-enum agent_started fields, or
 *  null to skip the event. Returns null when any required field is missing or
 *  outside its enum — a malformed/spoofed payload drops the event rather than
 *  poisoning it. used_custom_agent is absent/invalid => false (built-in,
 *  safe-fallback, and legacy-opaque launches are never custom). */
export function buildAgentStartedAttribution(
  telemetry: AgentStartedTelemetryInput | undefined
): AgentStartedAttribution | null {
  const agentKindParse = agentKindSchema.safeParse(telemetry?.agent_kind)
  const launchSourceParse = launchSourceSchema.safeParse(telemetry?.launch_source)
  const requestKindParse = requestKindSchema.safeParse(telemetry?.request_kind)
  if (!agentKindParse.success || !launchSourceParse.success || !requestKindParse.success) {
    return null
  }
  return {
    agent_kind: agentKindParse.data,
    launch_source: launchSourceParse.data,
    request_kind: requestKindParse.data,
    used_custom_agent: telemetry?.used_custom_agent === true
  }
}
