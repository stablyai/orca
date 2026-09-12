import type { PtyOwnershipTransferAttachmentResult } from '../../../shared/pty-ownership-transfer-control-wire'
import { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION } from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferCoordinatorOptions } from './pty-ownership-transfer-coordinator-contract'
import { assertTransferIdentity } from './pty-ownership-transfer-response-identity'

export async function attachRecoveredPtyOwnershipTransferSourceRoute(
  options: PtyOwnershipTransferCoordinatorOptions,
  capabilities: NonNullable<PtyOwnershipTransferCoordinatorOptions['destinationCapabilities']>,
  phase: 'committed' | 'published',
  durableReconnectGeneration: number | undefined,
  attachmentId: string,
  requestOptions: { signal?: AbortSignal; timeoutMs?: number }
): Promise<PtyOwnershipTransferAttachmentResult> {
  if (capabilities.reconnectRekey) {
    return await rekeyRecoveredRoute(
      options,
      capabilities,
      phase,
      durableReconnectGeneration,
      attachmentId,
      requestOptions
    )
  }
  if (!options.source.attachDestination) {
    throw new Error('pty_ownership_transfer_recovery_destination_attachment_unconfigured')
  }
  const result = await options.source.attachDestination(
    {
      ...options.identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      attachmentId
    },
    capabilities,
    requestOptions
  )
  assertTransferIdentity(result, options.identity)
  return result
}

async function rekeyRecoveredRoute(
  options: PtyOwnershipTransferCoordinatorOptions,
  capabilities: NonNullable<PtyOwnershipTransferCoordinatorOptions['destinationCapabilities']>,
  phase: 'committed' | 'published',
  durableReconnectGeneration: number | undefined,
  attachmentId: string,
  requestOptions: { signal?: AbortSignal; timeoutMs?: number }
): Promise<PtyOwnershipTransferAttachmentResult> {
  if (
    !options.source.rekeyReconnect ||
    !options.getReconnectGeneration ||
    durableReconnectGeneration === undefined
  ) {
    throw new Error('pty_ownership_transfer_recovery_reconnect_rekey_unavailable')
  }
  const reconnectGeneration = await options.getReconnectGeneration(requestOptions)
  if (
    !Number.isSafeInteger(reconnectGeneration) ||
    reconnectGeneration <= durableReconnectGeneration
  ) {
    throw new Error('pty_ownership_transfer_recovery_reconnect_generation_invalid')
  }
  const rekeyed = await options.source.rekeyReconnect(
    {
      ...options.identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      previousReconnectGeneration: durableReconnectGeneration,
      reconnectGeneration,
      attachmentId
    },
    capabilities,
    requestOptions
  )
  assertTransferIdentity(rekeyed, options.identity)
  if (
    rekeyed.previousReconnectGeneration !== durableReconnectGeneration ||
    rekeyed.reconnectGeneration !== reconnectGeneration ||
    rekeyed.attachmentId !== attachmentId ||
    rekeyed.phase !== phase
  ) {
    throw new Error('pty_ownership_transfer_recovery_rekey_result_invalid')
  }
  return Object.freeze({
    ...options.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: rekeyed.phase,
    attachmentId: rekeyed.attachmentId,
    executionVerdict: rekeyed.executionVerdict,
    ...(rekeyed.exit ? { exit: rekeyed.exit } : {})
  })
}
