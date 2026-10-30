// Centralize the runtimeId envelope and error-code contracts that clients use for decisions and display.
import { AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE } from '../../../shared/agent-launch-surface'
import {
  agentSessionRefusalReference,
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import type { RpcEnvelopeMeta, RpcFailure, RpcSuccess } from './core'
import { CONNECTOR_REPLY_ERROR_CODES } from '../../../shared/rpc-contract/connector-params'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES } from '../../../shared/orchestration-session-caller-codes'
import { computerUseErrorRecoveryData } from '../../../shared/computer-use-error-recovery'
import { COMPUTER_ERROR_CODES } from '../../../shared/runtime-types'
import { TerminalSplitOutcomeError } from '../../../shared/terminal-split-outcome'
import { WslHostWindowsDriveRefusalError } from '../../../shared/wsl-host-windows-drive-refusal'
import { wslDistroHoldRpcFailure } from '../../../shared/wsl-distro-stopped-hold'
import { LINEAR_ERROR_CODES } from '../../../shared/linear/agent-access'
import { AGENT_SESSION_RPC_ERROR_CODES } from '../../../shared/agent-session-host-authority'
import { ARTIFACT_SHARING_DISABLED_CODE } from '../../../shared/artifact-sharing-gate'
import { AGENT_SKILL_SHARING_DISABLED_CODE } from '../../../shared/agent-skill-sharing-gate'
import { SHARING_UNAVAILABLE_ON_HOST_CODE } from '../../../shared/sharing-unavailable-on-host'
import {
  AGENT_SKILL_NOT_SHAREABLE_CODE,
  AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
  AGENT_SKILL_SELECTOR_NOT_FOUND_CODE,
  AGENT_SKILL_SHARING_BUSY_CODE,
  AGENT_SKILL_BUNDLE_NAME_TAKEN_CODE,
  AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE
} from '../../../shared/agent-skill-sharing-contract'
import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  classifySkillInstallFailureCode
} from '../../../shared/skill-install-failure'
import { PLUGIN_CLI_ERROR_CODES } from '../../../shared/plugins/approval/plugin-cli-approval'
import { GIT_DIFF_TOO_LARGE_CODE } from '../../../shared/git-diff-transport-budget'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../../shared/automation-owner-conflict'
import { ARCHIVE_HOOK_FAILED_REMOVAL_CODE } from '../../../shared/worktree/archive-hook-removal-gate'
import { NESTED_WORKER_DEPTH_EXCEEDED_CODE } from '../../../shared/nested-worker-depth'
import { PROJECT_RUNTIME_REPAIR_REQUIRED_CODE } from '../../../shared/project-runtime-repair-message'
import { WORKTREE_CREATE_COLLISION_CODE } from '../../../shared/new-workspace/worktree-create-collision'
import { AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE } from '../../../shared/agent-launch-pane-already-live'
import { AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE } from '../../../shared/agent-launch-session-already-exists'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../shared/agent-launch-tab-closed'
import { AGENT_LAUNCH_TARGET_FORBIDDEN_CODE } from '../../../shared/agent-launch-target-forbidden'
import {
  parseTerminalSpawnDeferral,
  TERMINAL_SPAWN_DEFERRED_CODE
} from '../../../shared/host-spawn-admission'

export function successResponse(id: string, meta: RpcEnvelopeMeta, result: unknown): RpcSuccess {
  return {
    id,
    ok: true,
    result,
    _meta: meta
  }
}

export function errorResponse(
  id: string,
  meta: RpcEnvelopeMeta,
  code: string,
  message: string,
  data?: unknown
): RpcFailure {
  return {
    id,
    ok: false,
    error: data === undefined ? { code, message } : { code, message, data },
    _meta: meta
  }
}

// Runtime plain Error messages are stable codes; changing this allowlist also requires updating the CLI.
const RUNTIME_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
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

const COMPUTER_PASSTHROUGH_CODES: ReadonlySet<string> = new Set(Object.values(COMPUTER_ERROR_CODES))
const LINEAR_PASSTHROUGH_CODES: ReadonlySet<string> = new Set(LINEAR_ERROR_CODES)
const STRUCTURED_RUNTIME_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  WORKTREE_CREATE_COLLISION_CODE,
  AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE,
  'worktree_id_requires_full_path',
  'run_not_found',
  'run_home_unreachable',
  'run_required',
  'stable_pane_required',
  'consumer_fenced',
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
  'worker_identity_changed',
  'cursor_invalid',
  'cursor_dispatch_mismatch',
  'source_changed',
  'transcript_required',
  'server_required',
  'worktree_not_found_on_server',
  'resource_server_mismatch',
  'peer_changed',
  'remote_runtime_unavailable',
  'runtime_timeout',
  'invalid_runtime_response',
  'capability_unsupported',
  'relay_quota_exceeded',
  'dispatch_capability_invalid',
  'agent_unconfigured',
  'worker_prompt_too_large',
  'terminal_worktree_mismatch',
  'terminal_is_coordinator',
  'worker_cannot_coordinate_own_run',
  'worker_cannot_take_over_run',
  'request_mismatch',
  'mutation_ledger_full',
  'legacy_read_only',
  'orchestration_migration_required',
  'operation_unknown',
  'dispatch_preamble_undelivered',
  'question_not_found',
  'answer_conflict',
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

export function mapRuntimeError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (isAgentSessionRefusalError(error)) {
    return agentSessionRefusalErrorResponse(id, meta, error)
  }
  if (
    error instanceof TerminalSplitOutcomeError ||
    error instanceof WslHostWindowsDriveRefusalError
  ) {
    // Keeps the code callers already match; the split's id or the refusal kind rides in `data`.
    return errorResponse(id, meta, 'runtime_error', message, error.data)
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    COMPUTER_PASSTHROUGH_CODES.has((error as { code: string }).code)
  ) {
    const code = (error as { code: string }).code
    return errorResponse(id, meta, code, message, computerErrorData(code, message))
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('LINEAGE_')
  ) {
    return errorResponse(
      id,
      meta,
      (error as { code: string }).code,
      message,
      (error as { data?: unknown }).data
    )
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    LINEAR_PASSTHROUGH_CODES.has((error as { code: string }).code)
  ) {
    return errorResponse(
      id,
      meta,
      (error as { code: string }).code,
      message,
      (error as { data?: unknown }).data
    )
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    STRUCTURED_RUNTIME_PASSTHROUGH_CODES.has((error as { code: string }).code)
  ) {
    return errorResponse(
      id,
      meta,
      (error as { code: string }).code,
      message,
      (error as { data?: unknown }).data
    )
  }
  if (RUNTIME_PASSTHROUGH_CODES.has(message)) {
    return errorResponse(id, meta, message, message)
  }
  const deferral = parseTerminalSpawnDeferral(message)
  if (deferral) {
    // Why: only a caller that sent spawnIntent can be deferred, so the code is new to no client.
    return errorResponse(id, meta, TERMINAL_SPAWN_DEFERRED_CODE, message, { reason: deferral })
  }
  const skillInstallFailure = classifySkillInstallFailureCode(message)
  if (skillInstallFailure) {
    return errorResponse(
      id,
      meta,
      SKILL_INSTALL_RPC_ERROR_CODE,
      skillInstallFailure.code,
      skillInstallFailure
    )
  }
  // Same code older clients match; people read the sentence, programs the hold in `data`.
  const held = wslDistroHoldRpcFailure(message)
  if (held) {
    return errorResponse(id, meta, 'runtime_error', held.message, held.data)
  }
  if (message === 'invalid_terminal_send') {
    return errorResponse(id, meta, 'invalid_argument', 'Missing terminal send payload')
  }
  return errorResponse(id, meta, 'runtime_error', message)
}

/** Map agent-session refusals before generic code passthrough; preserve released clients' exact code/message and add ignored details only in data. */
function agentSessionRefusalErrorResponse(
  id: string,
  meta: RpcEnvelopeMeta,
  error: AgentSessionRefusalError
): RpcFailure {
  const { code } = error.refusal
  return errorResponse(
    id,
    meta,
    RUNTIME_PASSTHROUGH_CODES.has(code) ? code : 'runtime_error',
    code,
    { refusal: agentSessionRefusalReference(error.refusal) }
  )
}

export const computerErrorData = computerUseErrorRecoveryData

// BrowserError.code uses the browser namespace, separate from the runtime message-code allowlist.
export function mapBrowserError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return errorResponse(id, meta, (error as { code: string }).code, error.message)
  }
  return mapRuntimeError(id, meta, error)
}

// EmulatorError.code likewise uses its own namespace rather than generic runtime_error.
export function mapEmulatorError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return errorResponse(id, meta, (error as { code: string }).code, error.message)
  }
  return mapRuntimeError(id, meta, error)
}
