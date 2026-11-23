import { WORKTREE_CREATE_COLLISION_CODE } from '../../../shared/new-workspace/worktree-create-collision'
import { AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE } from '../../../shared/agent-launch/contracts/agent-launch-pane-already-live'
import { AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE } from '../../../shared/agent-launch/contracts/agent-launch-session-already-exists'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../shared/agent-launch/contracts/agent-launch-tab-closed'
import { AGENT_LAUNCH_TARGET_FORBIDDEN_CODE } from '../../../shared/agent-launch/contracts/agent-launch-target-forbidden'
import { CONNECTOR_REPLY_ERROR_CODES } from '../../../shared/rpc-contract/connectors/connector-params'
import { BOT_ERROR_CODES } from '../../../shared/rpc-contract/bots-params'
import { AGENT_SESSION_RPC_ERROR_CODES } from '../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'

// Runtime plain Error messages are stable codes; changing this allowlist also requires updating the CLI.
export const RUNTIME_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  WORKTREE_CREATE_COLLISION_CODE,
  AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE,
  AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE,
  AGENT_LAUNCH_TAB_CLOSED_CODE,
  AGENT_LAUNCH_TARGET_FORBIDDEN_CODE,
  'agent_launch_replay_unsupported',
  'runtime_unavailable',
  'chat_fork_source_unavailable',
  'chat_fork_runtime_incompatible',
  'chat_fork_anchor_changed',
  'selector_not_found',
  'observer_scope_stale',
  'selector_ambiguous',
  'terminal_handle_stale',
  'terminal_not_writable',
  'terminal_exited',
  'terminal_gone',
  'terminal_tab_close_timeout',
  'terminal_tab_not_found',
  'terminal_tab_pinned',
  'agent_prompt_blocked',
  'agent_prompt_stalled',
  'no_active_terminal',
  'repo_not_found',
  'timeout',
  'invalid_limit',
  'request_aborted',
  'remote_update_manual_required',
  'remote_update_not_available',
  'remote_update_not_downloaded',
  'connectors_disabled',
  'external_conversation_not_found',
  ...CONNECTOR_REPLY_ERROR_CODES,
  ...BOT_ERROR_CODES,
  ...AGENT_SESSION_RPC_ERROR_CODES
])
