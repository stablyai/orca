import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { sameAgentIdentity } from '../../../../shared/agent-status/title/agent-title-owner'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

export type PtyLaunchFacts = Pick<
  RuntimePtyWorktreeRecord,
  'launchToken' | 'launchAgent' | 'launchConfig'
>

/** The note of the Orca launch main still holds for this PTY as `agent`; a typed agent gets none.
 *  A wrapper launch (Claude agent teams) reports its wrapped agent, which is still that launch. */
export function attestedLaunchConfig(
  pty: PtyLaunchFacts | null | undefined,
  agent: string | null | undefined
): SleepingAgentLaunchConfig | undefined {
  return pty?.launchToken &&
    pty.launchConfig &&
    agent &&
    pty.launchAgent &&
    sameAgentIdentity(pty.launchAgent, agent)
    ? pty.launchConfig
    : undefined
}
