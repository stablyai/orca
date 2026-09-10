import type { RuntimeTerminalClose } from '../../shared/runtime-types'
import { parsePtyStopReceipt } from '../../shared/pty-stop-receipt'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { OrcaRuntimeService } from './orca-runtime'
import type { TerminalCloseIntent } from './orchestration/db/terminal-close-intent-store'
import { OrchestrationError } from './orchestration/orchestration-error'

export async function reconcileTerminalCloseIntent(args: {
  runtime: OrcaRuntimeService
  intent: TerminalCloseIntent
  close: () => Promise<RuntimeTerminalClose>
}): Promise<RuntimeTerminalClose> {
  const { runtime, intent } = args
  const db = runtime.getOrchestrationDb()
  if (intent.result !== null) {
    return parseStoredResult(intent)
  }
  db.assertTerminalCloseIntentAuthority(intent)
  const current = await resolveCurrentIdentity(runtime, intent.terminalHandle).catch(() => null)
  if (
    !current ||
    current.executionHostId !== intent.executionHostId ||
    current.workspaceKey !== intent.workspaceKey ||
    current.ptyIncarnation !== intent.ptyIncarnation ||
    current.processRootId !== intent.processRootId
  ) {
    db.updateTerminalCloseIntent(intent.mutationId, {
      state: 'outcome_unknown',
      lastError: 'terminal_identity_unverifiable'
    })
    throw new OrchestrationError(
      'terminal_close_outcome_unknown',
      `Terminal ${intent.terminalHandle} no longer has the reserved process identity.`
    )
  }
  db.updateTerminalCloseIntent(intent.mutationId, { state: 'closing' })
  let result: RuntimeTerminalClose
  try {
    result = await args.close()
  } catch (error) {
    db.updateTerminalCloseIntent(intent.mutationId, {
      state: 'outcome_unknown',
      lastError: error instanceof Error ? error.message : 'terminal_close_failed'
    })
    throw error
  }
  const settled = classifyResult(intent, result)
  db.updateTerminalCloseIntent(intent.mutationId, {
    state: settled.state,
    result,
    lastError: settled.error,
    autoRelease: settled.state === 'released'
  })
  return result
}

async function resolveCurrentIdentity(runtime: OrcaRuntimeService, terminalHandle: string) {
  const [terminal, ptyIncarnation] = await Promise.all([
    runtime.showTerminal(terminalHandle),
    Promise.resolve(runtime.getTerminalProcessIncarnation(terminalHandle))
  ])
  if (!terminal.ptyId || !ptyIncarnation) {
    throw new Error('terminal_identity_unverifiable')
  }
  const executionHostId = normalizeExecutionHostId(terminal.executionHostId)
  if (!executionHostId || !terminal.worktreeId) {
    throw new Error('terminal_identity_unverifiable')
  }
  return {
    executionHostId,
    workspaceKey: parseWorkspaceKey(terminal.worktreeId)
      ? terminal.worktreeId
      : worktreeWorkspaceKey(terminal.worktreeId),
    ptyIncarnation,
    processRootId: terminal.ptyId
  }
}

function classifyResult(
  intent: TerminalCloseIntent,
  result: RuntimeTerminalClose
): { state: TerminalCloseIntent['state']; error: string | null } {
  const executionHostId = requireExecutionHostId(intent.executionHostId)
  if (!result.ptyStopReceipt) {
    return { state: 'outcome_unknown', error: 'pty_stop_receipt_missing' }
  }
  let receipt
  try {
    receipt = parsePtyStopReceipt(result.ptyStopReceipt, {
      executionHostId,
      terminalHandle: intent.terminalHandle,
      ptyId: intent.processRootId,
      ptyIncarnation: intent.ptyIncarnation
    })
  } catch (error) {
    return {
      state: 'outcome_unknown',
      error: error instanceof Error ? error.message : 'pty_stop_receipt_malformed'
    }
  }
  if (receipt.verdict === 'capability_limited') {
    return { state: 'capability_limited', error: receipt.reason }
  }
  if (receipt.verdict !== 'exited' || !receipt.processTreeVerified || !result.ptyKilled) {
    return { state: 'outcome_unknown', error: `pty_stop_${receipt.verdict}` }
  }
  return { state: 'released', error: null }
}

function parseStoredResult(intent: TerminalCloseIntent): RuntimeTerminalClose {
  const value = intent.result
  if (!isRecord(value) || typeof value.handle !== 'string' || typeof value.tabId !== 'string') {
    throw new OrchestrationError('close_intent_result_invalid', 'Close intent result is invalid.')
  }
  if (value.handle !== intent.terminalHandle || typeof value.ptyKilled !== 'boolean') {
    throw new OrchestrationError(
      'close_intent_result_invalid',
      'Close intent result identity is invalid.'
    )
  }
  if (value.ptyStopReceipt !== undefined) {
    parsePtyStopReceipt(value.ptyStopReceipt, {
      executionHostId: requireExecutionHostId(intent.executionHostId),
      terminalHandle: intent.terminalHandle,
      ptyId: intent.processRootId,
      ptyIncarnation: intent.ptyIncarnation
    })
  }
  return value as RuntimeTerminalClose
}

function requireExecutionHostId(value: string) {
  const executionHostId = normalizeExecutionHostId(value)
  if (!executionHostId) {
    throw new OrchestrationError('close_intent_result_invalid', 'Close intent host is invalid.')
  }
  return executionHostId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
