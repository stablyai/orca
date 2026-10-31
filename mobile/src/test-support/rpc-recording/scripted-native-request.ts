import type { RpcResponse } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import { captureArguments, captureError, observeSettlement } from './recording-values'

import type { ScriptedRpcTransport } from './scripted-rpc-transport'

export function scriptedNativeRequest(
  owner: ScriptedRpcTransport,
  args: Parameters<RpcClient['sendRequest']>
) {
  return owner.causality.invoke(args, (child) => {
    let promise: Promise<RpcResponse>
    try {
      promise = owner.logical.sendRequest(...args)
    } catch (error) {
      child.settlement = owner.fault.capture('native synchronous settlement', () => ({
        status: 'rejected',
        startedAt: child.settlement.startedAt,
        settledAt: owner.now(),
        error: captureError(error)
      }))
      throw error
    }
    observeSettlement(
      promise,
      owner.now,
      (state) => {
        child.settlement = state
        if (state.status !== 'pending') {
          child.afterArgs = captureArguments(args)
        }
        if (owner.causality.isBridgeChild(child) && state.status !== 'pending') {
          child.terminalOrdinal = owner.nextWriteOrdinal()
        }
      },
      (error) => owner.fault.report('native settlement', error)
    )
    return promise
  })
}
