import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcResponse } from '../transport/types'

type ActivationClient = Pick<RpcClient, 'sendRequest'>

type MobileSessionTabActivationParams = {
  worktree: string
  tabId: string
  leafId?: string
  notifyClients: false
}

async function retryIdempotentActivationAfterCutover(
  request: () => Promise<RpcResponse>
): Promise<RpcResponse> {
  try {
    return await request()
  } catch (error) {
    if (!(error instanceof LogicalClientCutoverError)) {
      throw error
    }
    // Why: cutover rejects ambiguous in-flight work after the replacement is
    // active; these state-setting requests are idempotent and safe to repeat once.
    return request()
  }
}

export function focusMobileTerminal(
  client: ActivationClient,
  terminal: string
): Promise<RpcResponse> {
  return retryIdempotentActivationAfterCutover(() =>
    client.sendRequest('terminal.focus', { terminal })
  )
}

export function activateMobileSessionTab(
  client: ActivationClient,
  params: MobileSessionTabActivationParams
): Promise<RpcResponse> {
  return retryIdempotentActivationAfterCutover(() =>
    client.sendRequest('session.tabs.activate', params)
  )
}
