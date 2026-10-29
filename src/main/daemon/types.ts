import type {
  AsyncIoHealthRequest,
  FullDiskAccessStatusRequest,
  PingRequest,
  PtySpawnHealthRequest,
  SystemResolverHealthRequest
} from './daemon-health-requests'
import type { SpawnIntent } from '../../shared/host-spawn-admission'
import type { SessionInfo } from './daemon-session-info'
import type {
  ConfirmForegroundProcessRequest,
  ConfirmShellForegroundRequest,
  GetForegroundProcessRequest,
  InspectProcessRequest
} from './daemon-foreground-process-protocol'

export type {
  ConfirmForegroundProcessRequest,
  ConfirmShellForegroundRequest,
  GetForegroundProcessRequest,
  InspectProcessRequest
} from './daemon-foreground-process-protocol'

import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type * as HistorySeedProtocol from './terminal-history-seed-transfer-protocol'
import type * as PtyOwnerQueryProtocol from './daemon-pty-owner-query-protocol'
export type { TerminalModes } from './terminal-modes'
import type { TerminalSnapshot } from './terminal-snapshot'
export type { TerminalSnapshot } from './terminal-snapshot'
export {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  ASYNC_CWD_VALIDATION_DAEMON_PROTOCOL_VERSION,
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION,
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  PTY_STARTUP_INGRESS_PROTOCOL_VERSION,
  MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION,
  supportsMode2031UnsubscribeFact,
  supportsPtyStartupIngress
} from './daemon-protocol-version'

export type SessionState = 'created' | 'spawning' | 'running' | 'exiting' | 'exited'

export type ShellReadyState = 'pending' | 'ready' | 'timed_out' | 'unsupported'

export type { TerminalCheckpointFile } from './daemon-checkpoint-file'

export type { DaemonEndpointIdentity, HelloMessage, HelloResponse } from './daemon-hello-protocol'

export type CreateOrAttachRequest = {
  id: string
  type: 'createOrAttach'
  payload: HistorySeedProtocol.CreateOrAttachHistorySeedPayload & {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    startupCommandDelivery?: StartupCommandDelivery
    launchAgent?: TuiAgent
    /** Rejects an absent session instead of interpreting mount uncertainty as create permission. */
    attachOnly?: boolean
    /** Preserve the selected shell instead of defaulting to the daemon’s platform fallback. */
    shellOverride?: string
    terminalShellArgs?: string[]
    /** Preferred WSL distro for generic `wsl.exe` launches. */
    terminalWindowsWslDistro?: string | null
    /** Preserve the selected PowerShell implementation so daemon and local spawns resolve the same executable. */
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
    shellReadySupported?: boolean
    shellReadyTimeoutMs?: number
    /** Server-side fence that prevents a client timeout from publishing an orphan PTY. */
    cancelAfterMs?: number
    startupIngress?: PtyStartupIngressIntent
    /** Optional; an old daemon ignores it and an old client omits it (legacy pacing). */
    spawnIntent?: SpawnIntent
    agentSessionEnsure?: {
      claim: AgentSessionExecutionClaim
      surface: AgentSessionSurfaceBinding
    }
  }
}

export type CancelCreateOrAttachRequest = {
  id: string
  type: 'cancelCreateOrAttach'
  payload: { sessionId: string; requestId?: string }
}

export type WriteRequest = {
  id: string
  type: 'write'
  payload: {
    sessionId: string
    data: string
  }
}

export type ResizeRequest = {
  id: string
  type: 'resize'
  payload: {
    sessionId: string
    cols: number
    rows: number
  }
}

// Producer flow-control notifications (v19+) avoid RPC latency; a 5s failsafe releases lost client pauses.
export type PausePtyRequest = {
  id: string
  type: 'pausePty'
  payload: {
    sessionId: string
  }
}

export type ResumePtyRequest = {
  id: string
  type: 'resumePty'
  payload: {
    sessionId: string
  }
}

// Older daemons ignore this notification; the adapter’s v20 gate prevents sequence-unsafe v19 thinning.
export type SetSessionBackgroundRequest = {
  id: string
  type: 'setSessionBackground'
  payload: {
    sessionId: string
    background: boolean
  }
}

export type KillRequest = {
  id: string
  type: 'kill'
  payload: {
    sessionId: string
    immediate?: boolean
    expectedIncarnationId?: string
    requireNoAgentOwner?: boolean
    requireUnattached?: boolean
  }
}

export type SignalRequest = {
  id: string
  type: 'signal'
  payload: {
    sessionId: string
    signal: string
  }
}

export type ListSessionsRequest = {
  id: string
  type: 'listSessions'
}

export type ShutdownIfIdleRequest = {
  id: string
  type: 'shutdownIfIdle'
}

export type DetachRequest = {
  id: string
  type: 'detach'
  payload: {
    sessionId: string
  }
}

export type GetCwdRequest = {
  id: string
  type: 'getCwd'
  payload: {
    sessionId: string
  }
}

// Why resetInputModes is a type, not a clear flag: an older daemon rejects it instead of clearing.
export type TerminalBufferActionRequest = {
  id: string
  type: 'clearScrollback' | 'resetInputModes'
  payload: {
    sessionId: string
  }
}

export type ShutdownRequest = {
  id: string
  type: 'shutdown'
  payload: {
    killSessions: boolean
  }
}

export type GetSnapshotRequest = {
  id: string
  type: 'getSnapshot'
  payload: {
    sessionId: string
    scrollbackRows?: number
  }
}

// Read applied dimensions to detect dropped or coerced fire-and-forget resizes.
export type GetSizeRequest = {
  id: string
  type: 'getSize'
  payload: {
    sessionId: string
  }
}

// Incremental checkpoint records (v13+) avoid serializing the full emulator on every checkpoint tick.
export type PendingOutputRecord =
  | { kind: 'output'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'clear' }

export type TakePendingOutputRequest = {
  id: string
  type: 'takePendingOutput'
  payload: {
    sessionId: string
    /** Take the snapshot and records atomically so cold restore cannot replay snapshot-covered bytes twice. */
    includeSnapshot?: boolean
    /** Final pre-teardown checkpoints may release held parser bytes without disturbing live or warm snapshots. */
    teardownSnapshot?: boolean
  }
}

export type TakePendingOutputResult = {
  records: PendingOutputRecord[]
  /** Absent on older daemons; records stays held-only with includeSnapshot to avoid mixed-version duplicate replay. */
  drainedRecords?: PendingOutputRecord[]
  /** Persist nondecreasing batch numbers to detect lost records; empty incremental takes repeat the prior value. */
  seq: number
  /** Lost pending records require a full snapshot checkpoint. */
  overflowed: boolean
  snapshot: TerminalSnapshot | null
}

export type DaemonRequest =
  | CreateOrAttachRequest
  | HistorySeedProtocol.TerminalHistorySeedTransferRequest
  | CancelCreateOrAttachRequest
  | WriteRequest
  | ResizeRequest
  | PausePtyRequest
  | ResumePtyRequest
  | SetSessionBackgroundRequest
  | KillRequest
  | SignalRequest
  | ListSessionsRequest
  | ShutdownIfIdleRequest
  | DetachRequest
  | GetCwdRequest
  | GetForegroundProcessRequest
  | InspectProcessRequest
  | ConfirmForegroundProcessRequest
  | ConfirmShellForegroundRequest
  | TerminalBufferActionRequest
  | ShutdownRequest
  | PingRequest
  | SystemResolverHealthRequest
  | PtySpawnHealthRequest
  | AsyncIoHealthRequest
  | FullDiskAccessStatusRequest
  | GetSnapshotRequest
  | GetSizeRequest
  | TakePendingOutputRequest
  | PtyOwnerQueryProtocol.CloseStartupQueryAuthorityRequest
  | PtyOwnerQueryProtocol.SetColorQueryReplyColorsRequest

export type RpcResponseOk<T = unknown> = {
  id: string
  ok: true
  payload: T
}

export type RpcResponseError = {
  id: string
  ok: false
  error: string
}

export type RpcResponse<T = unknown> = RpcResponseOk<T> | RpcResponseError

export type { DaemonCreateOrAttachResult as CreateOrAttachResult } from './daemon-create-or-attach-result'
export type GetSnapshotResult = {
  snapshot: TerminalSnapshot | null
}

export type ListSessionsResult = {
  sessions: SessionInfo[]
}

export type ShutdownIfIdleResult = {
  retiring: boolean
}

export type SystemResolverHealth = 'healthy' | 'unhealthy' | 'unknown'

export type SystemResolverHealthResult = {
  health: SystemResolverHealth
}

export type { DaemonSessionInfo, SessionInfo } from './daemon-session-info'

export type * from './daemon-stream-events'

// Fire-and-forget request IDs: the daemon processes these without a response.
export const NOTIFY_PREFIX = 'notify_'

export {
  TerminalAttachCanceledError,
  DaemonConnectionLostError,
  DaemonProtocolError,
  DaemonRequestTimeoutError,
  DAEMON_UNAVAILABLE_RECONNECT_MESSAGE,
  SessionNotFoundError
} from './daemon-errors'
