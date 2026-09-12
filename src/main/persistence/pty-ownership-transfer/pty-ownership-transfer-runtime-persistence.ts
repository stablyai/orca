import { join } from 'node:path'
import {
  PtyOwnershipTransferDestinationFileStore,
  ptyOwnershipTransferDestinationDirectory
} from './pty-ownership-transfer-destination-file-store'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { PtyOwnershipTransferDestinationOutputSink } from './pty-ownership-transfer-destination-output-sink'
import type { PtyOwnershipTransferDestinationRuntimeOptions } from './pty-ownership-transfer-destination-runtime-contract'

export function createPtyOwnershipTransferRuntimePersistence(
  options: PtyOwnershipTransferDestinationRuntimeOptions
) {
  const directory = ptyOwnershipTransferDestinationDirectory(
    options.store.getProfileStorageDirectory()
  )
  const destinationStore = new PtyOwnershipTransferDestinationFileStore({
    directory,
    catalogPublicationVersion: options.catalogPublicationVersion
  })
  const outputOutbox = new PtyOwnershipTransferDestinationOutputOutbox({
    directory: join(directory, 'output-outbox-v1')
  })
  const outputSink = new PtyOwnershipTransferDestinationOutputSink({
    outbox: outputOutbox,
    deliver: (identity, surfaceBinding, frame) => {
      if (options.publishPostCommitOutputAcknowledged) {
        return options.publishPostCommitOutputAcknowledged(identity, surfaceBinding, frame)
      }
      options.publishPostCommitOutput(identity, surfaceBinding, frame)
      return { identity, throughSeq: frame.seq }
    }
  })
  return { destinationStore, outputOutbox, outputSink }
}
