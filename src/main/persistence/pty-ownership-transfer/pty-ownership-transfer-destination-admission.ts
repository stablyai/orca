import type { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import type { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { samePtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { PtyOwnershipTransferAdmissionRecord } from './pty-ownership-transfer-admission-record'
import {
  sameOrcadManagedStopAuthority,
  type OrcadManagedStopAuthority
} from '../../../shared/orcad-managed-stop-authority'

export abstract class PtyOwnershipTransferDestinationAdmission {
  protected abstract readonly destinationStore: PtyOwnershipTransferDestinationFileStore
  protected abstract readonly outputOutbox: PtyOwnershipTransferDestinationOutputOutbox
  private admissionClosed = false
  private readonly admissionRecord: PtyOwnershipTransferAdmissionRecord
  private confirmedNativeReopening: Readonly<OrcadManagedStopAuthority> | null = null

  constructor(runtimeId: string, profileDirectory: string) {
    if (!runtimeId) {
      throw new Error('pty_ownership_transfer_destination_runtime_invalid')
    }
    this.admissionRecord = new PtyOwnershipTransferAdmissionRecord(profileDirectory, runtimeId)
    this.admissionClosed = this.admissionRecord.isClosed()
  }

  /** Synchronous discovery and fencing must precede the first awaited native retirement operation. */
  fenceAdmissionForDecommission(authority?: OrcadManagedStopAuthority): void {
    this.confirmedNativeReopening = null
    for (const candidate of this.destinationStore.listRecoveryCandidates()) {
      const retirement = this.outputOutbox.loadRetirement(candidate.journal)
      if (
        !candidate.requiresDelegatedSource ||
        candidate.journal.phase !== 'published' ||
        !candidate.journal.publicationReceipt ||
        !candidate.surfaceBinding ||
        retirement?.phase !== 'applied' ||
        !samePtyOwnershipTransferSurfaceBinding(
          candidate.surfaceBinding,
          retirement.event.surfaceBinding
        )
      ) {
        throw new Error('pty_ownership_transfer_decommission_destination_unverifiable')
      }
    }
    this.admissionClosed = true
    this.admissionRecord.close(authority)
  }

  reopenAdmissionAfterConfirmedNativeRefusal(authority?: OrcadManagedStopAuthority): void {
    this.confirmedNativeReopening = null
    this.admissionRecord.reopenAfterConfirmedNativeRefusal(authority)
    this.admissionClosed = false
    this.confirmedNativeReopening = authority ? Object.freeze({ ...authority }) : null
  }

  assertConfirmedNativeReopeningFor(authority: OrcadManagedStopAuthority): void {
    if (
      this.admissionClosed ||
      !this.confirmedNativeReopening ||
      !sameOrcadManagedStopAuthority(this.confirmedNativeReopening, authority)
    ) {
      throw new Error('pty_ownership_transfer_native_reopening_unverifiable')
    }
    this.admissionRecord.assertOpenFor(authority)
  }

  assertDestinationAdmissionOpen(): void {
    if (this.admissionClosed) {
      throw new Error('pty_ownership_transfer_destination_admission_closed')
    }
  }

  supportsCapturedCatalogPublication(): boolean {
    return !this.admissionClosed && this.destinationStore.surface.supportsCatalogPublication()
  }
}
