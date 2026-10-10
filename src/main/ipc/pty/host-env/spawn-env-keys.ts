import { ORCA_AGENT_SESSION_ID_ENV } from '../../../../shared/agent-session-caller-env'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../../../shared/agent-hook-scrub-safe-env'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../../../shared/structured-session-marker'

export const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'ORCA_AGENT_HOOK_ENDPOINT',
  // Why: PR 2778 briefly exported this path; keep deleting stale inherited values so older PTYs can't leak the reverted path.
  'ORCA_CLAUDE_AGENT_STATUS_SETTINGS'
] as const

// Why: Orca never sets these, so an inherited value means a pty host launched from inside a Claude session — Claude reads it as a nested child and silently stops persisting the transcript.
export const CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID'
] as const

// Why: Orca writes these only into a structured session's own spawn, so an inherited value means a pty host launched from inside one — every pane would claim that session as its orchestration caller.
export const ORCA_AGENT_SESSION_CALLER_ENV_KEYS = [
  ORCA_AGENT_SESSION_ID_ENV,
  ORCA_STRUCTURED_SESSION_ENV
] as const

// Why: these name the PTY pane a process belongs to, so an inherited value means a process started inside an Orca terminal, and any child that is not that pane would report its status there.
export const INHERITED_PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV
] as const
