import type { TuiAgent } from '../../shared/types'
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
  /** Undefined only when talking to a daemon predating WSL session context. */
  wslDistro?: string | null
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  incarnationId?: PtyIncarnationId
}

export function getDaemonSessionResultMetadata(session: {
  launchAgent: TuiAgent | null
  historySeeded: boolean | undefined
  wslDistro: string | null
}): {
  launchAgent?: TuiAgent
  historySeeded?: boolean
  wslDistro: string | null
} {
  return {
    ...(session.launchAgent ? { launchAgent: session.launchAgent } : {}),
    ...(session.historySeeded !== undefined ? { historySeeded: session.historySeeded } : {}),
    // Why: null authoritatively identifies a native session; omission is
    // reserved for older daemons that predate this wire field.
    wslDistro: session.wslDistro
  }
}
