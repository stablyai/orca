import { accountRestartErrorReceipt } from '../../../ipc/pty/pane/account-restart-owner'
import type { RpcFailure } from '../core'

export function withAccountRestartReceipt(response: RpcFailure, error: unknown): RpcFailure {
  const receipt = accountRestartErrorReceipt(error)
  if (!receipt) {
    return response
  }
  const data = response.error.data
  return {
    ...response,
    error: {
      ...response.error,
      data: { ...(data && typeof data === 'object' ? data : {}), accountRestart: receipt }
    }
  }
}
