import type { RpcContext } from '../core'
import type { RuntimePtyOwnershipTransferSourceAdapter } from '../../../providers/runtime-pty-ownership-transfer-source-adapter'

export function getSource(context: RpcContext): RuntimePtyOwnershipTransferSourceAdapter {
  const source = context.runtime.getLocalPtyOwnershipTransferSource?.()
  if (!source) {
    throw new Error('pty_ownership_transfer_runtime_source_unavailable')
  }
  return source
}

export function createBinding(
  context: RpcContext
): Parameters<RuntimePtyOwnershipTransferSourceAdapter['prepare']>[1] {
  const token = context.connectionId ?? context.pairedDeviceId ?? context.clientId ?? 'runtime'
  return {
    clientId: stableClientId(token),
    ...(context.transportGeneration === undefined
      ? {}
      : { transportGeneration: context.transportGeneration }),
    ...(context.pairedDeviceId === undefined ? {} : { pairedDeviceId: context.pairedDeviceId }),
    isStale: () => context.signal?.aborted === true
  }
}

function stableClientId(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0 || 1
}

export function requirePairedRuntimeClient(context: RpcContext): void {
  if (context.clientKind !== 'runtime' || !context.pairedDeviceId || !context.connectionId) {
    throw new Error('pty_ownership_transfer_runtime_client_required')
  }
}
