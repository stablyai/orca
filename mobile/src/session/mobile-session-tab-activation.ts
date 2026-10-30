import type { TabActivationIntent } from '../../../src/shared/tab-activation-intent'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { sessionTabActivate, sessionTerminalFocus } from './mobile-session-write-operations'
import type { RpcResponse } from '../transport/types'
import {
  getMobileTerminalDiagnosticErrorName,
  logMobileTerminalDiagnostic,
  shortenMobileTerminalDiagnosticId
} from './mobile-terminal-diagnostics'

type ActivationClient = Parameters<typeof sessionTerminalFocus.request>[0]

type MobileSessionTabActivationParams = {
  worktree: string
  tabId: string
  leafId?: string
  notifyClients: false
  navigation: 'caller'
  /** Required so each call site declares whether a user asked for this. */
  intent: TabActivationIntent
}

async function retryIdempotentActivationAfterCutover(
  request: () => Promise<RpcResponse>,
  operation: 'terminal.focus' | 'session.tabs.activate',
  target: string
): Promise<RpcResponse> {
  const diagnosticTarget = shortenMobileTerminalDiagnosticId(target)
  logMobileTerminalDiagnostic('activation-request', { operation, target: diagnosticTarget })
  try {
    const response = await request()
    logMobileTerminalDiagnostic('activation-result', {
      operation,
      target: diagnosticTarget,
      ok: response.ok,
      rpcCode: response.ok ? null : response.error.code
    })
    return response
  } catch (error) {
    if (!(error instanceof LogicalClientCutoverError)) {
      logMobileTerminalDiagnostic('activation-error', {
        operation,
        target: diagnosticTarget,
        errorName: getMobileTerminalDiagnosticErrorName(error)
      })
      throw error
    }
    logMobileTerminalDiagnostic('activation-cutover-retry', {
      operation,
      target: diagnosticTarget
    })
    // Cutover activates the replacement before rejecting old requests; repeat these idempotent state writes once.
    try {
      const response = await request()
      logMobileTerminalDiagnostic('activation-result', {
        operation,
        target: diagnosticTarget,
        ok: response.ok,
        rpcCode: response.ok ? null : response.error.code
      })
      return response
    } catch (retryError) {
      logMobileTerminalDiagnostic('activation-error', {
        operation,
        target: diagnosticTarget,
        errorName: getMobileTerminalDiagnosticErrorName(retryError)
      })
      throw retryError
    }
  }
}

export function focusMobileTerminal(
  client: ActivationClient,
  terminal: string
): Promise<RpcResponse> {
  return retryIdempotentActivationAfterCutover(
    () => sessionTerminalFocus.request(client, { terminal, navigation: 'host' }),
    'terminal.focus',
    terminal
  )
}

export type PendingCrossWorktreeTabTarget = {
  worktreeId: string
  tabId: string
  leafId?: string
  terminalHandle?: string
}

let pendingCrossWorktreeTabTarget: PendingCrossWorktreeTabTarget | null = null

export function setPendingCrossWorktreeTabTarget(
  target: PendingCrossWorktreeTabTarget | null
): void {
  if (!target) {
    pendingCrossWorktreeTabTarget = null
    return
  }
  const worktreeId = target.worktreeId.startsWith('id:')
    ? target.worktreeId.slice(3)
    : target.worktreeId
  pendingCrossWorktreeTabTarget = worktreeId ? { ...target, worktreeId } : null
}

export function consumePendingCrossWorktreeTabTarget(
  worktree: string
): PendingCrossWorktreeTabTarget | null {
  const normalized = worktree.startsWith('id:') ? worktree.slice(3) : worktree
  if (!normalized || pendingCrossWorktreeTabTarget?.worktreeId !== normalized) {
    return null
  }
  const target = pendingCrossWorktreeTabTarget
  pendingCrossWorktreeTabTarget = null
  return target
}

export function activateMobileSessionTab(
  client: ActivationClient,
  params: MobileSessionTabActivationParams
): Promise<RpcResponse> {
  return retryIdempotentActivationAfterCutover(
    () => sessionTabActivate.request(client, params),
    'session.tabs.activate',
    params.tabId
  )
}
