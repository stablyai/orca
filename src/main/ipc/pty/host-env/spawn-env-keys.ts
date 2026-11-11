import { ORCA_AGENT_SESSION_ID_ENV } from '../../../../shared/agent-session/lifecycle/agent-session-caller-env'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../../../shared/structured-session-marker'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../../../shared/agent-hook-listener/transport/agent-hook-scrub-safe-env'

export const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'ORCA_AGENT_HOOK_ENDPOINT',
  // Remove the reverted inherited path still present in older PTYs (#2778).
  'ORCA_CLAUDE_AGENT_STATUS_SETTINGS'
] as const

export const AGENT_PANE_HOOK_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ...AGENT_HOOK_RUNTIME_ENV_KEYS
] as const

// Inherited structured-session IDs would make every pane claim the parent orchestration caller.
export const ORCA_AGENT_SESSION_CALLER_ENV_KEYS = [
  ORCA_AGENT_SESSION_ID_ENV,
  ORCA_STRUCTURED_SESSION_ENV
] as const
