import type {
  ConfirmForegroundProcessRequest,
  GetForegroundProcessRequest
} from './daemon-foreground-process-protocol'

export type {
  ConfirmForegroundProcessRequest,
  GetForegroundProcessRequest
} from './daemon-foreground-process-protocol'

// ─── Protocol Version ────────────────────────────────────────────────
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/types'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
export type { TerminalModes } from './terminal-modes'
import type { TerminalSnapshot } from './terminal-snapshot'
export type { TerminalSnapshot } from './terminal-snapshot'
export {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION,
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  PTY_STARTUP_INGRESS_PROTOCOL_VERSION,
  supportsPtyStartupIngress
} from './daemon-protocol-version'

// ─── Session State Machine ──────────────────────────────────────────
export type SessionState = 'created' | 'spawning' | 'running' | 'exiting' | 'exited'

export type ShellReadyState = 'pending' | 'ready' | 'timed_out' | 'unsupported'

// The on-disk checkpoint.json shape lives in daemon-checkpoint-file.ts (it
// depends only on TerminalModes here) — re-exported so existing importers of
// `./types` keep working.
export type { TerminalCheckpointFile } from './daemon-checkpoint-file'

// ─── NDJSON Protocol Messages ───────────────────────────────────────

// Hello handshake (first message on each socket)
export type { DaemonEndpointIdentity, HelloMessage, HelloResponse } from './daemon-hello-protocol'

// ─── RPC Requests (Client → Daemon, on control socket) ─────────────

export type CreateOrAttachRequest = {
  id: string
  type: 'createOrAttach'
  payload: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    startupCommandDelivery?: StartupCommandDelivery
    launchAgent?: TuiAgent
    /** Explicit Windows shell override selected by the user (e.g. 'wsl.exe').
     *  The daemon forwards this to its subprocess spawner so each tab honors
     *  the shell picked in the "+" menu or the persisted default-shell setting,
     *  instead of defaulting to COMSPEC (which is always cmd.exe on Windows)
     *  or the hard-coded powershell.exe fallback. */
    shellOverride?: string
    /** Preferred WSL distro for generic `wsl.exe` launches. */
    terminalWindowsWslDistro?: string | null
    /** Why: the UI keeps PowerShell as one shell family, but the runtime may
     *  need to substitute pwsh.exe for powershell.exe when the user selected
     *  PowerShell 7+. Forward the persisted implementation choice so the daemon
     *  PTY path resolves the same effective executable as LocalPtyProvider. */
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
    shellReadySupported?: boolean
    shellReadyTimeoutMs?: number
    /** Recovered ANSI applied before the new subprocess can emit startup output. */
    historySeed?: string
    startupIngress?: PtyStartupIngressIntent
  }
}

export type CloseStartupQueryAuthorityRequest = {
  id: string
  type: 'closeStartupQueryAuthority'
  payload: { sessionId: string }
}

export type CancelCreateOrAttachRequest = {
  id: string
  type: 'cancelCreateOrAttach'
  payload: {
    sessionId: string
  }
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

// ─── Producer flow control (v19+) ───────────────────────────────────
// Why fire-and-forget notifications (like write/resize): pause/resume ride the
// hot data path and are best-effort — the daemon-side 5s failsafe, not an RPC
// reply, is what guarantees a paused shell can never stay wedged.
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

// Why the notification stays backward-tolerated: unknown notify types are
// swallowed by old daemons. The adapter's v20 capability gate separately
// prevents v19 thinning without a sequence-safe recovery snapshot.
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

export type ClearScrollbackRequest = {
  id: string
  type: 'clearScrollback'
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

export type PingRequest = {
  id: string
  type: 'ping'
}

export type SystemResolverHealthRequest = {
  id: string
  type: 'systemResolverHealth'
}

export type PtySpawnHealthRequest = {
  id: string
  type: 'ptySpawnHealth'
}

export type GetSnapshotRequest = {
  id: string
  type: 'getSnapshot'
  payload: {
    sessionId: string
    scrollbackRows?: number
  }
}

// Why: read-only readback of the size the PTY actually applied (vs the size the
// renderer last requested via the fire-and-forget resize notify). Lets the
// renderer's resume drift-check re-assert a resize the daemon dropped/coerced.
export type GetSizeRequest = {
  id: string
  type: 'getSize'
  payload: {
    sessionId: string
  }
}

// ─── Incremental checkpoint records (v13+) ──────────────────────────
// Why: the 5s checkpoint used to re-serialize the full emulator buffer per
// tick, stalling the daemon's PTY pump for O(buffer). Incremental checkpoints
// take only the raw records accumulated since the last take; the emulator is
// serialized only when a full snapshot is explicitly requested (clean
// shutdown, pending-buffer overflow, or the on-disk log reaching its cap).
export type PendingOutputRecord =
  | { kind: 'output'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'clear' }

export type TakePendingOutputRequest = {
  id: string
  type: 'takePendingOutput'
  payload: {
    sessionId: string
    /** When true, the daemon serializes a full snapshot in the SAME
     *  synchronous turn as the take. This atomicity is load-bearing: a
     *  snapshot taken in a separate request could include bytes that a later
     *  take would replay again, duplicating content on cold restore. */
    includeSnapshot?: boolean
    /** True only for final checkpoints taken immediately before PTY teardown.
     *  This lets the daemon release pending parser-state bytes that should be
     *  preserved before the backing PTY is destroyed, without disturbing live
     *  full checkpoints or warm-reconnect checkpoints. */
    teardownSnapshot?: boolean
  }
}

export type TakePendingOutputResult = {
  records: PendingOutputRecord[]
  /** Monotonic per-session batch sequence. The history log stores it so the
   *  cold-restore reader can detect a lost batch (gap) and discard the log
   *  instead of replaying a stream with missing bytes. */
  seq: number
  /** True when the session's pending buffer exceeded its cap and records were
   *  dropped. The caller must fall back to a full snapshot checkpoint. */
  overflowed: boolean
  snapshot: TerminalSnapshot | null
}

export type DaemonRequest =
  | CreateOrAttachRequest
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
  | ConfirmForegroundProcessRequest
  | ClearScrollbackRequest
  | ShutdownRequest
  | PingRequest
  | SystemResolverHealthRequest
  | PtySpawnHealthRequest
  | GetSnapshotRequest
  | GetSizeRequest
  | TakePendingOutputRequest
  | CloseStartupQueryAuthorityRequest

// ─── RPC Responses (Daemon → Client, on control socket) ────────────

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

export type SessionInfo = {
  sessionId: string
  state: SessionState
  shellState: ShellReadyState
  isAlive: boolean
  terminalHandle?: string
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
}

// Why: SessionInfo + source protocol version, so the Manage Sessions UI can
// label legacy-backed sessions. Populated by the router/adapter at RPC time;
// never transmitted over the daemon wire (daemon only speaks its own
// protocol version and doesn't know about other versions).
export type DaemonSessionInfo = SessionInfo & {
  protocolVersion: number
}

// Stream-socket event shapes live in daemon-stream-events.ts; re-exported so
// existing importers keep one types entry point.
export * from './daemon-stream-events'

// ─── Binary Frame Protocol (Daemon ↔ PTY Subprocess) ────────────────
//
// 5-byte header: [type:1][length:4 big-endian]
// Followed by `length` bytes of payload.

export const enum FrameType {
  Data = 0x01,
  Resize = 0x02,
  Exit = 0x03,
  Error = 0x04,
  Kill = 0x05,
  Signal = 0x06
}

export const FRAME_HEADER_SIZE = 5
export const FRAME_MAX_PAYLOAD = 1024 * 1024 // 1MB

// ─── Notify prefix ──────────────────────────────────────────────────
// Requests with IDs starting with this prefix are fire-and-forget:
// the daemon processes them but does not send a response.
export const NOTIFY_PREFIX = 'notify_'

// ─── Error types ────────────────────────────────────────────────────
// Re-exported so existing importers of `./types` keep working; the classes
// live in daemon-errors.ts (this file is capped for wire-shape declarations).
export {
  TerminalAttachCanceledError,
  DaemonProtocolError,
  SessionNotFoundError
} from './daemon-errors'
