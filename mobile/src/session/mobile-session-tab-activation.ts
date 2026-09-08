import type { TabActivationIntent } from '../../../src/shared/tab-activation-intent'
import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  getMobileTerminalDiagnosticErrorName,
  logMobileTerminalDiagnostic,
  shortenMobileTerminalDiagnosticId
} from './mobile-terminal-diagnostics'

type ActivationClient = Pick<RpcClient, 'sendRequest'>

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
  const terminal = operation === 'terminal.focus'
  const diagnosticTarget = shortenMobileTerminalDiagnosticId(target)
  logMobileTerminalDiagnostic('activation-request', { terminal, target: diagnosticTarget })
  const logResult = (response: RpcResponse) =>
    logMobileTerminalDiagnostic('activation-result', {
      terminal,
      target: diagnosticTarget,
      ok: response.ok,
      // Why: without the code a failed activation is indistinguishable from a rejected one.
      rpcCode: response.ok ? null : response.error.code
    })
  try {
    const response = await request()
    logResult(response)
    return response
  } catch (error) {
    if (!(error instanceof LogicalClientCutoverError)) {
      logMobileTerminalDiagnostic('activation-error', {
        terminal,
        target: diagnosticTarget,
        errorName: getMobileTerminalDiagnosticErrorName(error)
      })
      throw error
    }
    logMobileTerminalDiagnostic('activation-cutover-retry', {
      terminal,
      target: diagnosticTarget
    })
    // Why: cutover rejects ambiguous in-flight work after the replacement is
    // active; these state-setting requests are idempotent and safe to repeat once.
    try {
      const response = await request()
      logResult(response)
      return response
    } catch (retryError) {
      logMobileTerminalDiagnostic('activation-error', {
        terminal,
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
    () => client.sendRequest('terminal.focus', { terminal, navigation: 'host' }),
    'terminal.focus',
    terminal
  )
}

export function activateMobileSessionTab(
  client: ActivationClient,
  params: MobileSessionTabActivationParams
): Promise<RpcResponse> {
  return retryIdempotentActivationAfterCutover(
    () => client.sendRequest('session.tabs.activate', params),
    'session.tabs.activate',
    params.tabId
  )
}
