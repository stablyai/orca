import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { sameAgentIdentity } from '../../../../shared/agent-status/title/agent-title-owner'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

export type PtyLaunchFacts = Pick<
  RuntimePtyWorktreeRecord,
  | 'launchToken'
  | 'launchAgent'
  | 'launchConfig'
  | 'launchUndecided'
  | 'launchIncarnationId'
  | 'incarnationId'
>

/** The note of the Orca launch main still holds for this PTY's process as `agent`; a typed agent gets none.
 *  A wrapper launch (Claude agent teams) reports its wrapped agent, which is still that launch. */
export function attestedLaunchConfig(
  pty: PtyLaunchFacts | null | undefined,
  agent: string | null | undefined
): SleepingAgentLaunchConfig | undefined {
  return pty?.launchToken &&
    // A launch recorded before its process id was known belongs to the process until a replacement.
    (!pty.launchIncarnationId || pty.launchIncarnationId === pty.incarnationId) &&
    pty.launchConfig &&
    agent &&
    pty.launchAgent &&
    sameAgentIdentity(pty.launchAgent, agent)
    ? pty.launchConfig
    : undefined
}

/** Main's word on this PTY's launch: its note, null when none runs, undefined when main can't tell,
 *  so readers keep their pre-attestation rule for a terminal that predates this proof. */
export function launchStatement(
  pty: PtyLaunchFacts | null | undefined,
  agent: string | null | undefined
): SleepingAgentLaunchConfig | null | undefined {
  const note = attestedLaunchConfig(pty, agent)
  if (note) {
    return note
  }
  return pty?.launchUndecided && !pty.launchToken ? undefined : null
}
