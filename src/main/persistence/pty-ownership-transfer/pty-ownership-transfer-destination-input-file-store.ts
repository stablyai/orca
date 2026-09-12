import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal'
import {
  transitionDelegatedInputState,
  type DelegatedInputTransition
} from './pty-ownership-transfer-delegated-input-state'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES,
  type PtyOwnershipTransferDestinationFileRecord
} from './pty-ownership-transfer-destination-file'

type DestinationInputFileStoreContext = Readonly<{
  loadRecord: (identity: PtyOwnershipTransferIdentity) => PtyOwnershipTransferDestinationFileRecord
  persist: (
    identity: PtyOwnershipTransferIdentity,
    record: PtyOwnershipTransferDestinationFileRecord
  ) => void
  maxInputIds: number
}>

export class PtyOwnershipTransferDestinationInputFileStore {
  constructor(private readonly context: DestinationInputFileStoreContext) {}

  loadDelegated(identity: PtyOwnershipTransferIdentity) {
    return structuredClone(this.context.loadRecord(identity).delegatedInputs ?? null)
  }

  transitionDelegated(identity: PtyOwnershipTransferIdentity, command: DelegatedInputTransition) {
    const current = this.context.loadRecord(identity)
    requireInputPhase(current)
    if (!current.delegatedSource || !current.delegatedClaimIntent || current.inputIds.length) {
      throw new Error('delegated_input_journal_unavailable')
    }
    const next = transitionDelegatedInputState(
      current.delegatedInputs,
      command,
      this.context.maxInputIds
    )
    if (JSON.stringify(next) !== JSON.stringify(current.delegatedInputs)) {
      this.context.persist(identity, {
        ...current,
        version: current.version === 5 ? 5 : 4,
        delegatedInputs: next
      })
    }
    return structuredClone(next)
  }

  loadInputIds(
    identity: PtyOwnershipTransferIdentity
  ): readonly Readonly<{ inputId: string; data: string }>[] {
    return structuredClone(this.context.loadRecord(identity).inputIds)
  }

  acceptInput(
    identity: PtyOwnershipTransferIdentity,
    inputId: string,
    data: string
  ): 'accepted' | 'duplicate' | 'conflict' {
    const current = this.context.loadRecord(identity)
    requireInputPhase(current)
    const previous = current.inputIds.find((entry) => entry.inputId === inputId)
    if (current.delegatedInputs) {
      throw new Error('delegated_input_requires_epoch')
    }
    if (previous) {
      return previous.data === data ? 'duplicate' : 'conflict'
    }
    if (!inputId || inputId.length > 256 || current.inputIds.length >= this.context.maxInputIds) {
      throw new Error('pty_ownership_transfer_destination_input_capacity_exceeded')
    }
    const inputBytes = current.inputIds.reduce(
      (total, entry) =>
        total + Buffer.byteLength(entry.inputId, 'utf8') + Buffer.byteLength(entry.data, 'utf8'),
      Buffer.byteLength(inputId, 'utf8') + Buffer.byteLength(data, 'utf8')
    )
    if (inputBytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES) {
      throw new Error('pty_ownership_transfer_destination_input_capacity_exceeded')
    }
    this.context.persist(identity, {
      ...current,
      inputIds: [...current.inputIds, { inputId, data }]
    })
    return 'accepted'
  }

  retireInput(identity: PtyOwnershipTransferIdentity, inputIds: readonly string[]): number {
    const current = this.context.loadRecord(identity)
    requireInputPhase(current)
    const retired = new Set(inputIds)
    const remaining = current.inputIds.filter((entry) => !retired.has(entry.inputId))
    const removed = current.inputIds.length - remaining.length
    if (removed > 0) {
      this.context.persist(identity, { ...current, inputIds: remaining })
    }
    return removed
  }
}

function requireInputPhase(record: PtyOwnershipTransferDestinationFileRecord): void {
  if (record.journal.phase !== 'committed' && record.journal.phase !== 'published') {
    throw new Error('pty_ownership_transfer_destination_input_phase_invalid')
  }
}
