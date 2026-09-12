import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import type {
  RelayPtyOwnershipTransferAdapterState,
  RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'

/** Persist intent before cancellation; uncertain writes revoke destination publication authority. */
export function runRelayPtyRetirementWriteTransaction<
  E extends Readonly<{ phase: 'prepared' | 'retired' }>
>(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord,
  operation: {
    evidence: E
    installed: boolean
    running: boolean
    cleanup: { remove: (assertAuthority: () => void) => void }
    assertRemoved?: () => void
  },
  assertCurrent: () => void,
  install: (evidence: E) => void,
  verifyRemoval: boolean
): void {
  if (operation.running) {
    throw new Error('pty_source_retirement_busy')
  }
  if (verifyRemoval && !operation.assertRemoved) {
    throw new Error('pty_source_retirement_restart_reconstruction_required')
  }
  const persist = () => {
    assertCurrent()
    install(operation.evidence)
    operation.installed = true
    try {
      persistRelayPtyOwnershipTransfer(state, transfer)
    } catch (error) {
      transfer.destinationDelegationWriteUnverifiable = true
      transfer.destinationClaimBinding = undefined
      transfer.destinationOutputRoute?.dispose()
      transfer.destinationOutputRoute = undefined
      throw error
    }
    assertCurrent()
  }
  operation.running = true
  try {
    persist()
    if (operation.evidence.phase !== 'retired') {
      operation.cleanup.remove(assertCurrent)
    }
    if (verifyRemoval) {
      operation.assertRemoved!()
    }
    assertCurrent()
    operation.evidence = Object.freeze({ ...operation.evidence, phase: 'retired' })
    install(operation.evidence)
    persist()
    if (verifyRemoval) {
      operation.assertRemoved!()
      assertCurrent()
    }
  } finally {
    operation.running = false
  }
}
