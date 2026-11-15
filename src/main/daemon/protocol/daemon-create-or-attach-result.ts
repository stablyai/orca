import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { ShellReadyState } from './daemon-rpc-contract'
import type { TerminalSnapshot } from './terminal-snapshot'
import type { DaemonLaunchNote } from './daemon-launch-note-protocol'
import type { AgentSessionClaimedSpawnResult } from '../../../shared/agent-session/agent-session-host-authority'
import type { PtyIncarnationId } from '../../../shared/terminal/pty/lifecycle/pty-incarnation'

export type DaemonCreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
  launchAgent?: TuiAgent
  /** The launch main armed and has not retired, null for none; older daemons omit it. */
  launchNote?: DaemonLaunchNote | null
  /** Undefined only when talking to a daemon predating WSL session context. */
  wslDistro?: string | null
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  incarnationId?: PtyIncarnationId
  /** Daemon-side cwd access only; app-side TCC access is independent. Older daemons omit this field. */
  cwdReadableByDaemon?: boolean
  /** The live child can no longer take input through its PTY; older daemons omit this field. */
  inputClosed?: true
}

export function getDaemonSessionResultMetadata(session: {
  launchAgent: TuiAgent | null
  launchNote: { current: DaemonLaunchNote | null }
  historySeeded: boolean | undefined
  wslDistro: string | null
}): {
  launchAgent?: TuiAgent
  launchNote: DaemonLaunchNote | null
  historySeeded?: boolean
  wslDistro: string | null
} {
  return {
    ...(session.launchAgent ? { launchAgent: session.launchAgent } : {}),
    launchNote: session.launchNote.current,
    ...(session.historySeeded !== undefined ? { historySeeded: session.historySeeded } : {}),
    // Null identifies native sessions; only older daemons omit the field.
    wslDistro: session.wslDistro
  }
}
