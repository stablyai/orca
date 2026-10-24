/** Accept newer clients’ launch-source labels as unknown rather than blocking the launch. */

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
