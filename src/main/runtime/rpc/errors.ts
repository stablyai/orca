import { AgentLaunchDesktopCreateError } from './methods/agent-launch-execution-outcome'
import { formatTerminalStartFailure } from '../../../shared/terminal-start-failure'
// Centralize the runtimeId envelope and error-code contracts that clients use for decisions and display.
import {
  agentSessionRefusalReference,
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import type { RpcEnvelopeMeta, RpcFailure, RpcSuccess } from './core'
import { computerUseErrorRecoveryData } from '../../../shared/computer-use-error-recovery'
import { TerminalSplitOutcomeError } from '../../../shared/terminal-split-outcome'
import { WslHostWindowsDriveRefusalError } from '../../../shared/wsl-host-windows-drive-refusal'
import { wslDistroHoldRpcFailure } from '../../../shared/wsl-distro-stopped-hold'
import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  classifySkillInstallFailureCode
} from '../../../shared/skill-install-failure'
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

import {
  RUNTIME_PASSTHROUGH_CODES,
  COMPUTER_PASSTHROUGH_CODES,
  LINEAR_PASSTHROUGH_CODES,
  STRUCTURED_RUNTIME_PASSTHROUGH_CODES
} from './runtime-error-passthrough-codes'

export function mapRuntimeError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  if (error instanceof AgentLaunchDesktopCreateError) {
    const base = mapRuntimeError(id, meta, error.base)
    return {
      ...base,
      error: { ...base.error, data: { desktopCreate: { worktreeId: error.worktreeId } } }
    }
  }
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
