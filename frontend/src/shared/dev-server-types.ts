// ─── Dev Server Types ───────────────────────────────────────────────────────
// Types for the DevServer subsystem (SOL-002, CR-OB-002).
// Pure type file — no imports from other project modules.

export type DevServerConnectionType =
  | 'relay-ssh' // Orca SSH → deploy relay → stdin/stdout
  // Direction fix: these two were previously commented the other way
  // around — see agent/src/relay/agent-connection-relay.ts/
  // agent-connection-direct.ts's own header comments, which this now
  // matches, plus DevServerStep.tsx's DEV_SERVER_CONNECTION_TYPE_LABELS.
  | 'relay-websocket' // Orca connects WS → dev server (dev server only listens)
  | 'direct-websocket' // Dev server connects WS → Orca (reverse)

export type DevServerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

// A THIRD, distinct "status" concept from DevServerStatus (live relay
// connection state, above) and DevServerApprovalStatus (admin approval,
// below) — backend-go's coarse dev-server health/bootstrap state
// (infra.dev_servers.status). "pending" is the column default (dev server
// registered, not yet confirmed healthy) — bootstrap.ts's
// resumeBootstrapProgressIfAny treats it as "still bootstrapping", per
// BACKLOG-007's option 2 (reuse this coarse signal instead of adding a
// dedicated per-step bootstrap field).
export type DevServerHealthStatus = 'pending' | 'healthy' | 'degraded' | 'unhealthy'

// CR-DS-009: distinguishes a Dev Server Agent (git/fs/pty, package `agent/`)
// from a Mobile Emulator Agent (device.*, package `emulator/`) registered
// through the same DevServer registry. Maps 1:1 to backend-go's
// infrafleet.proto AgentKind enum (AGENT_KIND_DEV_SERVER/
// AGENT_KIND_MOBILE_EMULATOR) — see TASK-EMU-007. Optional/undefined means
// "unknown kind" and MUST be treated as a Dev Server Agent for back-compat
// with rows that predate this field (mirrors backend's AGENT_KIND_UNSPECIFIED
// defaulting to dev_server), never as a Mobile Emulator Agent.
export type AgentKind = 'dev-server' | 'mobile-emulator'

export type DevServer = {
  id: string // 'ds-<uuid>'
  name: string // Human label: "MacBook Pro M3"
  connectionType: DevServerConnectionType
  // relay-ssh specific:
  sshTargetId?: string // Links to existing SshTarget
  // relay-websocket / direct-websocket specific:
  wsUrl?: string // ws://devserver.local:6799
  // CR-DS-009: absent on rows from a backend that doesn't send this field
  // yet (or on local Electron dev servers, which have no Mobile Emulator
  // Agent registry) — treat as 'dev-server'. See AgentKind's doc comment.
  kind?: AgentKind
  // Runtime (not persisted — populated after handshake):
  status: DevServerStatus
  platform: NodeJS.Platform | null
  arch: string | null // 'arm64' | 'x64'
  nodeVersion: string | null
  lastConnectedAt: number | null
  lastError: string | null
  workspaceDir: string | null // Remote default workspace directory
  addedAt: number
  /** Capabilities the agent advertised at handshake (e.g. 'pty', 'pty.stream',
   *  'fs.watch'). Null until a successful handshake has completed at least once. */
  capabilities: readonly string[] | null
  // CR-DS-006: admin-approval + grouping. Optional since older cached/local
  // DevServer objects (pre-migration) won't carry these — callers should
  // treat a missing approvalStatus as 'pending_approval' (fail closed).
  approvalStatus?: DevServerApprovalStatus
  groupId?: string
  // Absent on a backend that predates this field — callers should treat a
  // missing healthStatus as unknown, not "pending" (unlike approvalStatus's
  // fail-closed convention above, there is no safe default to assume here).
  healthStatus?: DevServerHealthStatus
}

export type DevServerInput = {
  name: string
  connectionType: DevServerConnectionType
  sshTargetId?: string
  wsUrl?: string
  // CR-DS-009: which agent registers. Omitted = 'dev-server' (back-compat —
  // every caller before TASK-EMU-012c omitted this field entirely).
  kind?: AgentKind
}

/** Optional filter for `devServer.list`/`devServer.listForUser` — omitted
 *  or `undefined` returns every dev server regardless of kind, matching
 *  backend-go's empty-filter-means-no-filter convention (TASK-EMU-007). */
export type DevServerListFilter = {
  kind?: AgentKind
}

export type ConnectionTestResult =
  | { ok: true; platform: NodeJS.Platform; nodeVersion: string }
  | { ok: false; error: string; hint?: string }

/**
 * Persisted subset of DevServer.
 * Runtime-only fields (status, platform, arch, nodeVersion, lastConnectedAt, lastError)
 * are NOT persisted — they are reconstructed on startup from the live relay.
 */
export type PersistedDevServer = {
  id: string
  name: string
  connectionType: DevServerConnectionType
  sshTargetId?: string
  wsUrl?: string
  workspaceDir: string | null
  addedAt: number
}

// ─── Remote Preflight Status ──────────────────────────────────────────────────

/** Result of running preflight checks (gh, git) on a remote dev server */
export type RemotePreflightStatus = {
  devServerId: string
  platform: NodeJS.Platform
  checkedAt: number
  gh: {
    installed: boolean
    authenticated: boolean
    version?: string
  }
  // Why: GitLab CLI (glab) check via relay. Optional for backward compatibility
  // with older relay versions that don't report glab status (FE-TASK-08 / FE-SOL-04).
  glab?: {
    installed: boolean
    authenticated: boolean
    version?: string
  }
  git: {
    installed: boolean
    version?: string
    hasUserName: boolean
    hasUserEmail: boolean
  }
}

// ─── Per-Server Onboarding Checklist ─────────────────────────────────────────

/** Checklist state tracked per dev server (keyed by devServerId) */
export type PerServerChecklistState = {
  addedRepo?: boolean
  ranFirstAgent?: boolean
  ranSecondAgentOnSameTask?: boolean
  reviewedDiff?: boolean
  openedPr?: boolean
  addedFolder?: boolean
  openedFile?: boolean
  ranAgentOnFile?: boolean
}

// ─── Windows Terminal Capabilities ───────────────────────────────────────────

/** Windows-specific terminal capabilities detected from remote dev server */
export type WindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  pwshVersion?: string
  gitBashAvailable: boolean
  gitBashPath?: string
  /** Platform of the relay host (always 'win32' for Windows servers). */
  hostPlatform?: NodeJS.Platform | null
}

/**
 * Payload emitted by DevServerRelayBridge when a direct-websocket token is generated.
 * Shared between main process (IPC sender), preload, and renderer (IPC receiver).
 */
export type AgentTokenInfo = {
  /** ID of the DevServer this token belongs to */
  devServerId: string
  /** One-time token for agent to authenticate: format "agt-<devServerId>-<timestamp>" */
  agentToken: string
  /** Orca WebSocket URL the agent should connect to: "ws://<host>:6768/agent" */
  orcaUrl: string
}

// ─── Dev Server Access Control (CR-DS-006/007/008) ───────────────────────────
// docs/crs/v2/dev-server/CR-DS-006-dev-server-approval-and-grouping.md et seq.

export type DevServerApprovalStatus = 'pending_approval' | 'approved' | 'rejected'

export type DevServerGroup = {
  id: string
  tenantId: string
  name: string
  /** Empty = root of the tree. */
  parentGroupId: string
}

export type DevServerGranteeKind = 'department' | 'team'

export type DevServerGroupGrant = {
  id: string
  tenantId: string
  devServerGroupId: string
  granteeKind: DevServerGranteeKind
  granteeId: string
}

export type DevServerAccessRequestStatus = 'pending' | 'approved' | 'rejected'

export type DevServerAccessRequest = {
  id: string
  tenantId: string
  userId: string
  devServerGroupId: string
  status: DevServerAccessRequestStatus
  message: string
  createdAtUnixMs: number
}
