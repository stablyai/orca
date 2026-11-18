import { RECIPE_VM_REFUSAL_CODES } from '../../../../shared/remote-runtime/recipe-vm-wake'
import { AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE } from '../../../../shared/agent-launch/contracts/agent-launch-surface'
import { CONNECTOR_REPLY_ERROR_CODES } from '../../../../shared/rpc-contract/connectors/connector-params'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES } from '../../../../shared/orchestration/orchestration-session-caller-codes'
import { ORCHESTRATION_FEDERATION_ERROR_CODES } from '../../../../shared/orchestration/orchestration-federation-error-codes'
import { COMPUTER_ERROR_CODES } from '../../../../shared/computer/computer-use-runtime-types'
import { LINEAR_ERROR_CODES } from '../../../../shared/linear/agent-access'
import { AGENT_SESSION_RPC_ERROR_CODES } from '../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { ARTIFACT_SHARING_DISABLED_CODE } from '../../../../shared/artifacts/artifact-sharing-gate'
import { ARTIFACT_RATE_LIMITED_CODE } from '../../../../shared/artifacts/artifacts'
import { AGENT_SKILL_SHARING_DISABLED_CODE } from '../../../../shared/skills/sharing/agent-skill-sharing-gate'
import { SHARING_UNAVAILABLE_ON_HOST_CODE } from '../../../../shared/remote-runtime/host-status/sharing-unavailable-on-host'
import {
  AGENT_SKILL_NOT_SHAREABLE_CODE,
  AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
  AGENT_SKILL_SELECTOR_NOT_FOUND_CODE,
  AGENT_SKILL_SHARING_BUSY_CODE,
  AGENT_SKILL_BUNDLE_NAME_TAKEN_CODE,
  AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE
} from '../../../../shared/skills/sharing/agent-skill-sharing-contract'
import { SKILL_INSTALL_RPC_ERROR_CODE } from '../../../../shared/skills/installation/skill-install-failure'
import { PLUGIN_CLI_ERROR_CODES } from '../../../../shared/plugins/approval/plugin-cli-approval'
import { GIT_DIFF_TOO_LARGE_CODE } from '../../../../shared/git/diff/git-diff-transport-budget'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../../../shared/automations/ownership/automation-owner-conflict'
import { ARCHIVE_HOOK_FAILED_REMOVAL_CODE } from '../../../../shared/worktree/removal/archive-hook-removal-gate'
import { NESTED_WORKER_DEPTH_EXCEEDED_CODE } from '../../../../shared/orchestration/workers/nested-worker-depth'
import { PROJECT_RUNTIME_REPAIR_REQUIRED_CODE } from '../../../../shared/execution-host/project-runtime-repair-message'
import {
  WORKTREE_CREATE_COLLISION_CODE,
  WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE
} from '../../../../shared/new-workspace/worktree-create-collision'
import { AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE } from '../../../../shared/agent-launch/contracts/agent-launch-pane-already-live'
import { AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE } from '../../../../shared/agent-launch/contracts/agent-launch-session-already-exists'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../../shared/agent-launch/contracts/agent-launch-tab-closed'
import { AGENT_LAUNCH_TARGET_FORBIDDEN_CODE } from '../../../../shared/agent-launch/contracts/agent-launch-target-forbidden'

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
  ...AGENT_SESSION_RPC_ERROR_CODES
])

export const COMPUTER_PASSTHROUGH_CODES: ReadonlySet<string> = new Set(
  Object.values(COMPUTER_ERROR_CODES)
)
export const LINEAR_PASSTHROUGH_CODES: ReadonlySet<string> = new Set(LINEAR_ERROR_CODES)
export const STRUCTURED_RUNTIME_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  ...RECIPE_VM_REFUSAL_CODES,
  WORKTREE_CREATE_COLLISION_CODE,
  WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE,
  AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE,
  'worktree_id_requires_full_path',
  // A workspace selector's choices ride in data; a plain Error('selector_ambiguous') keeps the bare code.
  'selector_ambiguous',
  'run_not_found',
  'run_home_unreachable',
  'run_required',
  'stable_pane_required',
  'consumer_fenced',
  'session_link_refused',
  'owner_required',
  'participant_required',
  'control_turn_required',
  'task_not_found',
  'task_not_startable',
  'inject_rejected',
  'dispatch_not_found',
  'dispatch_run_mismatch',
  'task_run_mismatch',
  'terminal_not_found',
  // This live agent session never had a terminal; terminal_handle_stale would falsely imply one died.
  'terminal_unsupported_for_agent_session',
  'recipient_ambiguous',
  'recipient_run_mismatch',
  'dispatch_inactive',
  // Its start failed before an agent ran, so there is no output to read.
  'worker_never_started',
  'worker_identity_changed',
  'cursor_invalid',
  'cursor_dispatch_mismatch',
  'source_changed',
  'transcript_required',
  // A released worker's original transcript or chat is gone, or it never had one.
  'archive_unavailable',
  ...ORCHESTRATION_FEDERATION_ERROR_CODES,
  'dispatch_capability_invalid',
  'agent_unconfigured',
  'worker_prompt_too_large',
  'terminal_worktree_mismatch',
  'terminal_is_coordinator',
  // Another open Dispatch holds the terminal; data names it and says no effects were applied.
  'terminal_busy',
  // The user chose Keep open; only they can undo it, so a coordinator must not retry blindly.
  'terminal_kept_open',
  'worker_cannot_coordinate_own_run',
  'worker_cannot_take_over_run',
  'request_mismatch',
  'mutation_ledger_full',
  'legacy_read_only',
  'orchestration_migration_required',
  'operation_unknown',
  // A re-made pairing: work through the earlier one is not recovered, so the caller is told plainly.
  'server_pairing_changed',
  'dispatch_preamble_undelivered',
  'question_not_found',
  'answer_conflict',
  // A worker's permission prompt: only a person allows; Orca answers chat prompts only, while open.
  'approval_requires_person',
  'approval_not_open',
  'approval_option_missing',
  'approval_refused',
  'stale_delivery',
  'invalid_argument',
  // Preserve archive-hook failure so callers can retry, waive or skip it (#19334).
  ARCHIVE_HOOK_FAILED_REMOVAL_CODE,
  // Paired-only method refusal must match the mobile transport allowlist's forbidden code.
  'forbidden',
  NESTED_WORKER_DEPTH_EXCEEDED_CODE,
  PROJECT_RUNTIME_REPAIR_REQUIRED_CODE,
  GIT_DIFF_TOO_LARGE_CODE,
  ARTIFACT_SHARING_DISABLED_CODE,
  // The reset time and limit ride in data; the message already names them for people.
  ARTIFACT_RATE_LIMITED_CODE,
  AGENT_SKILL_SHARING_DISABLED_CODE,
  SHARING_UNAVAILABLE_ON_HOST_CODE,
  AGENT_SKILL_NOT_SHAREABLE_CODE,
  AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
  AGENT_SKILL_SELECTOR_NOT_FOUND_CODE,
  AGENT_SKILL_SHARING_BUSY_CODE,
  AGENT_SKILL_BUNDLE_NAME_TAKEN_CODE,
  AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE,
  SKILL_INSTALL_RPC_ERROR_CODE,
  ...PLUGIN_CLI_ERROR_CODES,
  // Keep owner conflicts distinct so clients can choose reload, re-adopt or stop offering the action.
  ...Object.values(AUTOMATION_OWNER_CONFLICT_CODES),
  ...Object.values(ORCHESTRATION_SESSION_CALLER_ERROR_CODES)
])
