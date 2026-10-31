export const ORCAD_PAIRING_REPAIR_FAILED_CODE = 'orcad_pairing_repair_failed'

export class OrcadManagedPairingRepairFailedError extends Error {
  readonly code = ORCAD_PAIRING_REPAIR_FAILED_CODE
  constructor(reason: string) {
    super(
      `${ORCAD_PAIRING_REPAIR_FAILED_CODE}: the Orca server on this host no longer accepts this ` +
        `computer, and Orca couldn't pair with it again over SSH: ${reason}. Nothing on the host ` +
        `was stopped; its terminals can't be verified until Orca pairs again. Connect again to retry.`
    )
    this.name = 'OrcadManagedPairingRepairFailedError'
  }
}
