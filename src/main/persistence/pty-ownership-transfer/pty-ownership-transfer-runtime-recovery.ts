import {
  prepareResultFromPtyOwnershipTransferRecoveryCandidate,
  type PtyOwnershipTransferDestinationRecoveryCandidate
} from './pty-ownership-transfer-destination-recovery-candidates'
import type {
  PreparedPtyOwnershipTransferDestination,
  RecoveredPtyOwnershipTransferDestination
} from './pty-ownership-transfer-destination-runtime-contract'
import type { PtyOwnershipTransferPrepareResult } from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import type { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { prepareDelegatedPtyOwnershipDestination } from './pty-ownership-transfer-delegated-preparation'
import type { PtyOwnershipTransferDestinationAdapter } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipModelRetirement } from './pty-ownership-transfer-model-retirement'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import type { PtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'

export function loadActivePtyOwnershipOutput(
  outbox: PtyOwnershipTransferDestinationOutputOutbox,
  identity: PtyOwnershipTransferWireIdentity
) {
  const output = outbox.load(identity)
  if (output && outbox.loadRetirement(identity)) {
    throw new Error('pty_ownership_transfer_model_retired')
  }
  return output
}

export type RecoverPtyOwnershipRetirement = (recovery: {
  retirement: PtyOwnershipModelRetirement
  outbox: PtyOwnershipTransferDestinationOutputOutbox
}) => void

export function readPublishedDelegatedPtyDestination(
  adapter: PtyOwnershipTransferDestinationAdapter,
  store: PtyOwnershipTransferDestinationFileStore,
  outbox: PtyOwnershipTransferDestinationOutputOutbox
) {
  const snapshot = adapter.snapshot()
  const output = loadActivePtyOwnershipOutput(outbox, snapshot.identity)
  if (
    snapshot.phase !== 'published' ||
    snapshot.surfaceBinding?.executionHostId !== 'local' ||
    !store.loadDelegatedSource(snapshot.identity) ||
    !output
  ) {
    throw new Error('pty_ownership_transfer_delegated_publication_unavailable')
  }
  return Object.freeze({ identity: snapshot.identity, store, outbox, adapter })
}

type RecoveryOptions = {
  runtimeId: string
  candidates: readonly PtyOwnershipTransferDestinationRecoveryCandidate[]
  prepare: (result: PtyOwnershipTransferPrepareResult) => PreparedPtyOwnershipTransferDestination
}

export function recoverPersistedPtyOwnershipAdapters(options: RecoveryOptions) {
  const recovered: RecoveredPtyOwnershipTransferDestination[] = []
  for (const candidate of options.candidates) {
    if (
      candidate.requiresDelegatedSource ||
      candidate.journal.destinationRuntimeId !== options.runtimeId
    ) {
      continue
    }
    const prepared = options.prepare(
      prepareResultFromPtyOwnershipTransferRecoveryCandidate(candidate)
    )
    recovered.push(
      Object.freeze({
        bridgeId: candidate.journal.bridgeId,
        destinationRuntimeId: candidate.journal.destinationRuntimeId,
        phase: prepared.snapshot.phase,
        adapter: prepared.adapter,
        snapshot: prepared.snapshot
      })
    )
  }
  return Object.freeze(recovered)
}

/** Reopen only source-bound records; missing durability is never repaired by inventing a cursor. */
export function recoverPersistedDelegatedPtyDestinations(
  options: RecoveryOptions & {
    strictAcknowledgements: boolean
    destinationStore: PtyOwnershipTransferDestinationFileStore
    outputOutbox: PtyOwnershipTransferDestinationOutputOutbox
    recoverRetirement?: RecoverPtyOwnershipRetirement
  }
) {
  const candidates = options.candidates.filter(
    (candidate) =>
      candidate.requiresDelegatedSource &&
      candidate.journal.destinationRuntimeId === options.runtimeId
  )
  const validated = candidates.map((candidate) => {
    const source = options.destinationStore.loadDelegatedSource(candidate.journal)
    if (
      !options.strictAcknowledgements ||
      !source ||
      candidate.surfaceBinding?.executionHostId !== 'local' ||
      !options.outputOutbox.load(candidate.journal)
    ) {
      throw new Error('pty_ownership_transfer_delegated_recovery_unavailable')
    }
    const retirement = options.outputOutbox.loadRetirement(candidate.journal)
    if (
      retirement &&
      (candidate.journal.phase !== 'published' ||
        !candidate.journal.publicationReceipt ||
        !samePtyOwnershipTransferIdentity(retirement.event.identity, candidate.journal) ||
        JSON.stringify(retirement.event.surfaceBinding) !==
          JSON.stringify(candidate.surfaceBinding))
    ) {
      throw new Error('pty_ownership_transfer_retirement_publication_conflict')
    }
    if (retirement && !options.recoverRetirement) {
      throw new Error('pty_ownership_transfer_retirement_recovery_required')
    }
    return { candidate, source, retirement }
  })
  // Finish retirement before any candidate can republish a surface or restore its model.
  for (const { candidate, retirement } of validated) {
    if (!retirement) {
      continue
    }
    options.recoverRetirement!({ retirement, outbox: options.outputOutbox })
    if (options.outputOutbox.loadRetirement(candidate.journal)?.phase !== 'applied') {
      throw new Error('pty_ownership_transfer_retirement_recovery_incomplete')
    }
  }
  return Object.freeze(
    validated
      .filter(({ retirement }) => !retirement)
      .map(({ candidate, source }) => {
        const prepared = prepareDelegatedPtyOwnershipDestination(
          prepareResultFromPtyOwnershipTransferRecoveryCandidate(candidate),
          source,
          options
        )
        return Object.freeze({
          identity: prepared.snapshot.identity,
          store: options.destinationStore,
          outbox: options.outputOutbox,
          adapter: prepared.adapter
        })
      })
  )
}
