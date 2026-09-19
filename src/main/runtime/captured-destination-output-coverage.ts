import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { RuntimeCapturedPtyDestinationLifecycle } from './runtime-ownership-transfer-contracts'

export async function inspectRuntimeCapturedDestinationOutputCoverage(options: {
  identity: unknown
  throughSeq: number
  runtimeId: string
  signal: AbortSignal
  getLifecycle: () => RuntimeCapturedPtyDestinationLifecycle | undefined
  supportsPublication: () => boolean
}) {
  options.signal.throwIfAborted()
  const identity = parsePtyOwnershipTransferWireIdentity(options.identity)
  const lifecycle = options.getLifecycle()
  if (
    !Number.isSafeInteger(options.throughSeq) ||
    options.throughSeq < 0 ||
    !options.supportsPublication() ||
    identity.destinationRuntimeId !== options.runtimeId ||
    !lifecycle?.inspectPublishedDestinationOutputCoverage
  ) {
    throw new Error('pty_ownership_transfer_captured_output_coverage_unavailable')
  }
  const result = await lifecycle.inspectPublishedDestinationOutputCoverage(
    identity,
    options.throughSeq,
    options.signal
  )
  options.signal.throwIfAborted()
  if (options.getLifecycle() !== lifecycle || !options.supportsPublication()) {
    throw new Error('pty_ownership_transfer_captured_output_coverage_unavailable')
  }
  return result
}
