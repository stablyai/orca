import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { DaemonLaunchNote } from '../../../daemon/protocol/daemon-launch-note-protocol'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

export type PtyLaunchFacts = Pick<
  RuntimePtyWorktreeRecord,
  'launchToken' | 'launchAgent' | 'launchConfig'
>

/** The recipe of the Orca launch still running in this PTY as `agent`, the only proof that a saved
 *  note belongs to the agent there now. Main admits the launch token at spawn and retires it when
 *  that command finishes; a daemon reattach re-arms it only for the same unretired launch, so an
 *  agent typed into the shell gets none and resumes by the unrecorded rule. */
export function attestedLaunchConfig(
  pty: PtyLaunchFacts | null | undefined,
  agent: string | null | undefined
): SleepingAgentLaunchConfig | undefined {
  return pty?.launchToken && pty.launchConfig && agent && pty.launchAgent === agent
    ? pty.launchConfig
    : undefined
}

/** What the daemon keeps of the launch main admitted, so a reattach can re-arm it. */
export function daemonLaunchNoteOf(pty: PtyLaunchFacts): DaemonLaunchNote | null {
  return pty.launchToken && pty.launchConfig
    ? { launchToken: pty.launchToken, launchConfig: pty.launchConfig }
    : null
}

/** The owner's fact for a frame's PTY incarnation, so a paired client never keeps a retired launch's note. */
export function frameLaunchAttested(
  pty: PtyLaunchFacts | null | undefined,
  agent: string | null | undefined
): { launchAttested?: boolean } {
  return pty ? { launchAttested: attestedLaunchConfig(pty, agent) !== undefined } : {}
}
