import { BranchSwitchCollisionError } from '../../../git/worktrees/checkout/branch-switch-target'
import { BotItemError } from '../../../bots/bot-item-error'
import { BotSessionRefusedError } from '../../../bots/bot-session-refused-error'
import { AgentConversationRefusal } from '../../agent-conversations/agent-conversation-refusal'
import { SparsePresetValidationError } from '../../../../shared/worktree/creation/sparse-preset-failure'
import {
  RECIPE_VM_REFUSAL_CODES,
  RecipeVmWakeUnavailableError
} from '../../../../shared/remote-runtime/recipe-vm-wake'
import { RecipeWorkspaceRemovalError } from '../../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-host-removal'
import { formatTerminalStartFailure } from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
// Centralize the runtimeId envelope and error-code contracts that clients use for decisions and display.
import { AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE } from '../../../../shared/agent-launch/contracts/agent-launch-surface'
import {
  agentSessionRefusalReference,
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { RpcEnvelopeMeta, RpcFailure, RpcSuccess } from '../core'
import { RUNTIME_PASSTHROUGH_CODES } from '../runtime-passthrough-codes'
import { CONNECTOR_ACT_ERROR_CODES } from '../../../../shared/connector-action-contract'
import { BOTS_DISABLED_CODE } from '../../../../shared/bots-switch'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES } from '../../../../shared/orchestration/orchestration-session-caller-codes'
import { ORCHESTRATION_FEDERATION_ERROR_CODES } from '../../../../shared/orchestration/orchestration-federation-error-codes'
import { computerUseErrorRecoveryData } from '../../../../shared/computer/computer-use-error-recovery'
import { COMPUTER_ERROR_CODES } from '../../../../shared/computer/computer-use-runtime-types'
import { TerminalSplitOutcomeError } from '../../../../shared/workspace-layout/terminal-topology/terminal-split-outcome'
import { WslHostWindowsDriveRefusalError } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-windows-drive-refusal'
import { wslDistroHoldRpcFailure } from '../../../../shared/remote-runtime/wsl-hosts/wsl-distro-stopped-hold'
import { LINEAR_ERROR_CODES } from '../../../../shared/linear/agent-access'
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
import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  classifySkillInstallFailureCode
} from '../../../../shared/skills/installation/skill-install-failure'
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
import {
  parseTerminalSpawnDeferral,
  TERMINAL_SPAWN_DEFERRED_CODE
} from '../../../../shared/terminal/pty/admission/spawn-admission-contract'

export function successResponse(id: string, meta: RpcEnvelopeMeta, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: meta }
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

const COMPUTER_PASSTHROUGH_CODES: ReadonlySet<string> = new Set(Object.values(COMPUTER_ERROR_CODES))
const LINEAR_PASSTHROUGH_CODES: ReadonlySet<string> = new Set(LINEAR_ERROR_CODES)
const STRUCTURED_RUNTIME_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  ...CONNECTOR_ACT_ERROR_CODES,
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
  // Names the send that reaches the sender instead.
  'bot_reply_not_yours',
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
  'incompatible_runtime',
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
  BOTS_DISABLED_CODE,
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
  if (error instanceof BotItemError) {
    return errorResponse(id, meta, error.code, message, error.data)
  }
  if (error instanceof AgentConversationRefusal) {
    return errorResponse(id, meta, error.code, message)
  }
  // A recipe workspace removal keeps its environment's own code (archive hook, PTY stop, selector).
  if (
    error instanceof RecipeVmWakeUnavailableError ||
    error instanceof RecipeWorkspaceRemovalError
  ) {
    return errorResponse(id, meta, error.code, message, 'data' in error ? error.data : undefined)
  }
  if (
    error instanceof BranchSwitchCollisionError ||
    error instanceof TerminalSplitOutcomeError ||
    error instanceof SparsePresetValidationError ||
    error instanceof WslHostWindowsDriveRefusalError ||
    error instanceof BotSessionRefusedError
  ) {
    // Keep the existing RPC code while preserving structured details.
    return errorResponse(id, meta, 'runtime_error', message, error.data)
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    COMPUTER_PASSTHROUGH_CODES.has((error as { code: string }).code)
  ) {
    const code = (error as { code: string }).code
    return errorResponse(id, meta, code, message, computerUseErrorRecoveryData(code, message))
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
    (LINEAR_PASSTHROUGH_CODES.has((error as { code: string }).code) ||
      STRUCTURED_RUNTIME_PASSTHROUGH_CODES.has((error as { code: string }).code))
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
    return errorResponse(id, meta, message, formatTerminalStartFailure(error) ?? message)
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
  return errorResponse(id, meta, 'runtime_error', formatTerminalStartFailure(error) ?? message)
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
