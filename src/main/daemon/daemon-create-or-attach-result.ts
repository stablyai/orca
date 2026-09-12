import type { WorkOrigin } from '../../shared/work-origin'
import type { TuiAgent } from '../../shared/tui-agent'
import type { ShellReadyState, TerminalSnapshot } from './types'
import type { AgentSessionClaimedSpawnResult } from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export type DaemonCreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
  launchAgent?: TuiAgent
  workOrigin?: WorkOrigin
  /** Undefined only when talking to a daemon predating WSL session context. */
  wslDistro?: string | null
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  incarnationId?: PtyIncarnationId
  /**
   * Whether the daemon process itself could read the requested cwd at spawn. Only the daemon's own
   * verdict counts: macOS TCC scopes folder access per process tree, so the app's view of the same
   * path proves nothing about the daemon's (#17696). Omitted by daemons predating this field.
   */
  cwdReadableByDaemon?: boolean
}

export function getDaemonSessionResultMetadata(session: {
  workOrigin?: WorkOrigin
  launchAgent: TuiAgent | null
  historySeeded: boolean | undefined
  wslDistro: string | null
}): {
  launchAgent?: TuiAgent
  workOrigin?: WorkOrigin
  historySeeded?: boolean
  wslDistro: string | null
} {
  return {
    ...(session.workOrigin !== undefined ? { workOrigin: session.workOrigin } : {}),
    ...(session.launchAgent ? { launchAgent: session.launchAgent } : {}),
    ...(session.historySeeded !== undefined ? { historySeeded: session.historySeeded } : {}),
    // Why: null authoritatively identifies a native session; omission is
    // reserved for older daemons that predate this wire field.
    wslDistro: session.wslDistro
  }
}
