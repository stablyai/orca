import type { RelayPtyOwnershipTransferAdapterOptions } from './relay-pty-ownership-transfer-adapter-contract'

export function supportsRelayPtySourceRetirement(
  options: RelayPtyOwnershipTransferAdapterOptions
): boolean {
  return (
    !!options.store &&
    options.enableSourceDeliveryRetirement === true &&
    options.enableDestinationDelegationClaims === true &&
    options.enableDestinationDelegationCommit === true &&
    typeof options.prepareSourceDeliveryRetirement === 'function'
  )
}
