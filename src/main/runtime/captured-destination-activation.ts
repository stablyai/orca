import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { RuntimeCapturedPtyDestinationLifecycle } from './runtime-ownership-transfer-contracts'

export async function inspectRuntimeCapturedDestinationActivation(options: {
  identity: unknown
  runtimeId: string
  signal: AbortSignal
  getLifecycle: () => RuntimeCapturedPtyDestinationLifecycle | undefined
  supportsPublication: () => boolean
}) {
  options.signal.throwIfAborted()
  const identity = parsePtyOwnershipTransferWireIdentity(options.identity)
  const lifecycle = options.getLifecycle()
  if (
    !options.supportsPublication() ||
    identity.destinationRuntimeId !== options.runtimeId ||
    !lifecycle?.inspectPublishedDestinationActivation
  ) {
    throw new Error('pty_ownership_transfer_captured_activation_unavailable')
  }
  const result = await lifecycle.inspectPublishedDestinationActivation(identity, options.signal)
  options.signal.throwIfAborted()
  if (options.getLifecycle() !== lifecycle || !options.supportsPublication()) {
    throw new Error('pty_ownership_transfer_captured_activation_unavailable')
  }
  return result
}
