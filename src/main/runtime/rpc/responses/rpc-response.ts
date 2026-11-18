import {
  RUNTIME_PASSTHROUGH_CODES,
  COMPUTER_PASSTHROUGH_CODES,
  LINEAR_PASSTHROUGH_CODES,
  STRUCTURED_RUNTIME_PASSTHROUGH_CODES
} from './runtime-rpc-error-codes'
import { BranchSwitchCollisionError } from '../../../git/worktrees/checkout/branch-switch-target'
import { AgentConversationRefusal } from '../../agent-conversations/agent-conversation-refusal'
import { SparsePresetValidationError } from '../../../../shared/worktree/creation/sparse-preset-failure'
import { RecipeVmWakeUnavailableError } from '../../../../shared/remote-runtime/recipe-vm-wake'
import { RecipeWorkspaceRemovalError } from '../../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-host-removal'
import { formatTerminalStartFailure } from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
// Centralize the runtimeId envelope and error-code contracts that clients use for decisions and display.
import {
  agentSessionRefusalReference,
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { RpcEnvelopeMeta, RpcFailure, RpcSuccess } from '../core'
import { computerUseErrorRecoveryData } from '../../../../shared/computer/computer-use-error-recovery'
import { TerminalSplitOutcomeError } from '../../../../shared/workspace-layout/terminal-topology/terminal-split-outcome'
import { WslHostWindowsDriveRefusalError } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-windows-drive-refusal'
import { wslDistroHoldRpcFailure } from '../../../../shared/remote-runtime/wsl-hosts/wsl-distro-stopped-hold'
import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  classifySkillInstallFailureCode
} from '../../../../shared/skills/installation/skill-install-failure'
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

// Runtime plain Error messages are stable codes; changing this allowlist also requires updating the CLI.
export function mapRuntimeError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (isAgentSessionRefusalError(error)) {
    return agentSessionRefusalErrorResponse(id, meta, error)
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
    error instanceof WslHostWindowsDriveRefusalError
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
