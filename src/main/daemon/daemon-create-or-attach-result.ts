import type { TuiAgent } from '../../shared/tui-agent'
import type { ShellReadyState, TerminalSnapshot } from './types'
import type { AgentSessionClaimedSpawnResult } from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { CreateOrAttachResult } from './terminal-host-create-contract'

export type DaemonCreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  /** Optional for mixed-version clients; exact executable spawned by the host. */
  shellPath?: string
  shellState: ShellReadyState
  historySeeded?: boolean
  launchAgent?: TuiAgent
  /** Undefined only when talking to a daemon predating WSL session context. */
  wslDistro?: string | null
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  incarnationId?: PtyIncarnationId
}

export function toDaemonCreateOrAttachResult(
  result: CreateOrAttachResult
): DaemonCreateOrAttachResult {
  return {
    isNew: result.isNew,
    snapshot: result.snapshot,
    pid: result.pid,
    ...(result.shellPath ? { shellPath: result.shellPath } : {}),
    shellState: result.shellState,
    incarnationId: result.incarnationId,
    ...(result.launchAgent ? { launchAgent: result.launchAgent } : {}),
    wslDistro: result.wslDistro,
    ...(result.historySeeded !== undefined ? { historySeeded: result.historySeeded } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
  }
}

export function getDaemonSessionResultMetadata(session: {
  launchAgent: TuiAgent | null
  historySeeded: boolean | undefined
  wslDistro: string | null
  shellPath?: string
}): {
  launchAgent?: TuiAgent
  historySeeded?: boolean
  wslDistro: string | null
  shellPath?: string
} {
  return {
    ...(session.launchAgent ? { launchAgent: session.launchAgent } : {}),
    ...(session.historySeeded !== undefined ? { historySeeded: session.historySeeded } : {}),
    ...(session.shellPath ? { shellPath: session.shellPath } : {}),
    // Why: null authoritatively identifies a native session; omission is
    // reserved for older daemons that predate this wire field.
    wslDistro: session.wslDistro
  }
}
