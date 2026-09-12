import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { RuntimeCapturedPtyDestinationLifecycle } from './runtime-ownership-transfer-contracts'

export async function prepareRuntimeCapturedDestination(options: {
  request: Parameters<RuntimeCapturedPtyDestinationLifecycle['prepareCapturedDestination']>[0]
  runtimeId: string
  mutationEnabled: () => boolean
  getLifecycle: () => RuntimeCapturedPtyDestinationLifecycle | undefined
}) {
  if (!options.mutationEnabled()) {
    throw new Error('pty_ownership_transfer_production_disabled')
  }
  const identity = parsePtyOwnershipTransferWireIdentity(options.request.identity)
  if (identity.destinationRuntimeId !== options.runtimeId) {
    throw new Error('pty_ownership_transfer_captured_runtime_mismatch')
  }
  const lifecycle = options.getLifecycle()
  if (!lifecycle) {
    throw new Error('pty_ownership_transfer_captured_lifecycle_unavailable')
  }
  options.request.signal.throwIfAborted()
  return lifecycle.prepareCapturedDestination({ ...options.request, identity })
}
