import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type { PtyConsumerSessionGrant } from '../shared/pty-consumer-session'

export function ownedPtySourceDelivery(
  identity: PtySourceDeliveryIdentity | undefined,
  grant: Readonly<PtyConsumerSessionGrant>,
  id: string
): PtySourceDeliveryIdentity | null {
  if (
    !identity ||
    identity.id !== id ||
    identity.clientGeneration !== grant.clientGeneration ||
    identity.ownerGeneration !== grant.ownerGeneration
  ) {
    return null
  }
  return identity
}
