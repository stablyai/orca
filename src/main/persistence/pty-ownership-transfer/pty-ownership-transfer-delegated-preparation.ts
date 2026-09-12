import type { PtyOwnershipTransferPrepareResult } from '../../../shared/pty-ownership-transfer-wire'
import type { PreparedPtyOwnershipTransferDestination } from './pty-ownership-transfer-destination-runtime-contract'
import type { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import type { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { parsePtyOwnershipTransferDelegatedSource } from './pty-ownership-transfer-delegated-source'

export function prepareDelegatedPtyOwnershipDestination(
  result: PtyOwnershipTransferPrepareResult,
  source: unknown,
  options: {
    runtimeId: string
    strictAcknowledgements: boolean
    destinationStore: PtyOwnershipTransferDestinationFileStore
    outputOutbox: PtyOwnershipTransferDestinationOutputOutbox
    prepare: (result: PtyOwnershipTransferPrepareResult) => PreparedPtyOwnershipTransferDestination
  }
) {
  const binding = parsePtyOwnershipTransferDelegatedSource(source, result)
  if (
    result.destinationRuntimeId !== options.runtimeId ||
    result.surfacePublication?.surfaceBinding.executionHostId !== 'local' ||
    !options.strictAcknowledgements
  ) {
    throw new Error('pty_ownership_transfer_delegated_destination_unavailable')
  }
  const existingOutput = options.outputOutbox.load(result)
  if (
    existingOutput &&
    !options.destinationStore.loadDelegatedSource(result) &&
    existingOutput.acknowledgedEndSeq >
      (options.destinationStore.load(result)?.acceptedSourceEndSeq ?? result.replayStartSeq - 1)
  ) {
    throw new Error('pty_ownership_transfer_delegated_output_baseline_conflict')
  }
  if (!existingOutput) {
    options.outputOutbox.open(result, result.replayStartSeq - 1)
  }
  const prepared = options.prepare(result)
  options.destinationStore.bindDelegatedSource(result, binding)
  prepared.adapter.bindSurface(result.surfacePublication.surfaceBinding)
  return {
    adapter: prepared.adapter,
    snapshot: prepared.adapter.snapshot(),
    outputOutbox: options.outputOutbox
  }
}
