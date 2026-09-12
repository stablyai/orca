import type { RelayPtyOwnershipTransferRecord } from './relay-pty-ownership-transfer-adapter-state'

export function serializeDestinationMutationJournals(transfer: RelayPtyOwnershipTransferRecord) {
  return {
    ...(transfer.destinationControlJournal
      ? {
          destinationControlJournal: true as const,
          destinationControls: [...(transfer.destinationControls ?? [])].map(
            ([controlId, control]) => ({
              controlId,
              ...control
            })
          )
        }
      : {}),
    ...(transfer.destinationInputEpoch !== undefined
      ? { destinationInputEpoch: transfer.destinationInputEpoch }
      : {}),
    ...(transfer.destinationInputJournal
      ? {
          destinationInputJournal: true as const,
          destinationInputs: [...(transfer.destinationInputs ?? [])].map(([inputId, input]) => ({
            inputId,
            ...input
          }))
        }
      : {})
  }
}
