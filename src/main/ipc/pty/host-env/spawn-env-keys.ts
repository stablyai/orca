import { ORCA_AGENT_SESSION_ID_ENV } from '../../../../shared/agent-session-caller-env'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../../../shared/structured-session-marker'

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

// Inherited Claude child stamps make an independent pane act as the launching session's child.
export const CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT'
] as const

// Inherited structured-session IDs would make every pane claim the parent orchestration caller.
export const ORCA_AGENT_SESSION_CALLER_ENV_KEYS = [
  ORCA_AGENT_SESSION_ID_ENV,
  ORCA_STRUCTURED_SESSION_ENV
] as const
