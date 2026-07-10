import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

// ─── Protocol Version ────────────────────────────────────────────────
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'

// Why: daemons survive app updates; bump for IPC shape or baked behavior that
// wrapper refresh cannot deliver, so old daemons reject unsupported RPCs.
export const PROTOCOL_VERSION = 19
export const PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18
] as const

// ─── Session State Machine ──────────────────────────────────────────
export type SessionState = 'created' | 'spawning' | 'running' | 'exiting' | 'exited'

export type ShellReadyState = 'pending' | 'ready' | 'timed_out' | 'unsupported'

// ─── Terminal Snapshot ──────────────────────────────────────────────
export type TerminalSnapshot = {
  snapshotAnsi: string
  /** Scrollback portion only (rows above the visible viewport). Write this
   *  to preserve history without interfering with TUI repaints. */
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  /** The trailing partial escape sequence left unparsed in the emulator when a
   *  PTY read ended mid-escape. serialize() cannot carry it (it lives in the
   *  parser, not the buffer), so the restorer must write it LAST — after any
   *  post-snapshot reset — so the next live chunk's continuation completes the
   *  sequence instead of rendering literally (#7329). */
  pendingEscapeTailAnsi?: string
  cwd: string | null
  modes: TerminalModes
  cols: number
  rows: number
  scrollbackLines: number
  lastTitle?: string
}

export type TerminalModes = {
  bracketedPaste: boolean
  mouseTracking: boolean
  mouseTrackingMode?: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  sgrMouseMode?: boolean
  sgrMousePixelsMode?: boolean
  applicationCursor: boolean
  alternateScreen: boolean
  /** Kitty keyboard protocol flags (CSI > u) the session's TUI negotiated;
   *  0/absent when inactive. SerializeAddon cannot capture these, so the
   *  emulator mirrors them for snapshot rehydration. */
  kittyKeyboardFlags?: number
}

// The on-disk checkpoint.json shape lives in daemon-checkpoint-file.ts (it
// depends only on TerminalModes here) — re-exported so existing importers of
// `./types` keep working.
export type { TerminalCheckpointFile } from './daemon-checkpoint-file'

// ─── NDJSON Protocol Messages ───────────────────────────────────────

// Hello handshake (first message on each socket)
export type HelloMessage = {
  type: 'hello'
  version: number
  token: string
  clientId: string
  role: 'control' | 'stream'
}

export type HelloResponse = {
  type: 'hello'
  ok: boolean
  error?: string
}

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
  }
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

export type GetForegroundProcessRequest = {
  id: string
  type: 'getForegroundProcess'
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
  | KillRequest
  | SignalRequest
  | ListSessionsRequest
  | DetachRequest
  | GetCwdRequest
  | GetForegroundProcessRequest
  | ClearScrollbackRequest
  | ShutdownRequest
  | PingRequest
  | SystemResolverHealthRequest
  | PtySpawnHealthRequest
  | GetSnapshotRequest
  | GetSizeRequest
  | TakePendingOutputRequest

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

export type CreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
}

export type GetSnapshotResult = {
  snapshot: TerminalSnapshot | null
}

export type ListSessionsResult = {
  sessions: SessionInfo[]
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

// ─── Events (Daemon → Client, on stream socket) ────────────────────

export type DataEvent = {
  type: 'event'
  event: 'data'
  sessionId: string
  payload: { data: string }
}

export type ExitEvent = {
  type: 'event'
  event: 'exit'
  sessionId: string
  payload: { code: number }
}

export type TerminalErrorEvent = {
  type: 'event'
  event: 'terminalError'
  sessionId: string
  payload: { message: string }
}

export type DaemonEvent = DataEvent | ExitEvent | TerminalErrorEvent

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
export class TerminalAttachCanceledError extends Error {
  constructor(sessionId: string) {
    super(`Attach canceled for session ${sessionId}`)
    this.name = 'TerminalAttachCanceledError'
  }
}

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonProtocolError'
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}
