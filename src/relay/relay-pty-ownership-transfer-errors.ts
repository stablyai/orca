export class RelayPtyOwnershipTransferError extends Error {
  constructor(
    readonly reason:
      | 'identity-mismatch'
      | 'not-found'
      | 'already-transferring'
      | 'invalid-phase'
      | 'replay-unavailable'
      | 'destination-not-caught-up'
      | 'receipt-invalid'
      | 'input-conflict'
      | 'input-deduplication-window-exhausted'
      | 'control-conflict'
      | 'control-deduplication-window-exhausted'
      | 'reconnect-rekey-required'
      | 'stale-reconnect-generation'
      | 'stale-attachment'
      | 'execution-unverifiable'
      | 'stale-request',
    message: string
  ) {
    super(message)
    this.name = 'RelayPtyOwnershipTransferError'
  }
}
