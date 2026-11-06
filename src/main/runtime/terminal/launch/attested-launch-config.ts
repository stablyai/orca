import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

export type PtyLaunchFacts = Pick<
  RuntimePtyWorktreeRecord,
  'launchToken' | 'launchAgent' | 'launchConfig'
>

/** The recipe of the Orca launch still running in this PTY as `agent`, the only proof that a saved
 *  note belongs to the agent there now. Main admits the launch token at spawn and retires it when
 *  that command finishes; a daemon reattach restores neither, so an agent typed into the shell, or
 *  one a restarted main never saw start, gets none and resumes by the unrecorded rule. */
export function attestedLaunchConfig(
  pty: PtyLaunchFacts | null | undefined,
  agent: string | null | undefined
): SleepingAgentLaunchConfig | undefined {
  return pty?.launchToken && pty.launchConfig && agent && pty.launchAgent === agent
    ? pty.launchConfig
    : undefined
}
