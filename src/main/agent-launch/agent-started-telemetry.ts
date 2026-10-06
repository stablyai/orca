/**
 * The `agent_started` triple for an agent launch the host builds, of which only `launch_source`
 * comes from the caller.
 *
 * `agent_kind` and `request_kind` are derived rather than accepted — the host already knows both,
 * and a value it derives is a value a caller cannot misreport. `request_kind` is always `new`
 * because a host-built launch is always a fresh agent.
 *
 * Every launch is attributed: a caller that names no surface, or one this build has never heard of
 * (a newer client), is recorded as `unknown` rather than dropped. The wire keeps the arm set open so
 * an older host cannot refuse a newer client's launch over a label, and resolving it here, leniently,
 * keeps that label from gating the launch at the point it is actually used.
 */

import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { launchSourceSchema } from '../../shared/telemetry-property-schemas'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'

export function agentStartedTelemetry(
  agent: TuiAgent,
  launchSource: string | undefined
): NonNullable<WorktreeStartupLaunch['telemetry']> {
  const parsed = launchSourceSchema.safeParse(launchSource)
  return {
    agent_kind: tuiAgentToAgentKind(agent),
    launch_source: parsed.success ? parsed.data : 'unknown',
    request_kind: 'new'
  }
}
