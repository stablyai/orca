import type { SshPtySourceAckPublication } from './ssh-pty-source-obligation-contract'
import {
  reclaimPublishedSourcePrefix,
  type SpanRecord,
  type TokenRecord
} from './ssh-pty-source-obligation-state'

export function createSshPtySourceAckPublication(
  token: TokenRecord,
  endSu: number,
  spanOwners: Map<string, SpanRecord>,
  onPublished: () => void
): SshPtySourceAckPublication {
  let settled = false
  return Object.freeze({
    identity: token.identity,
    ack: Object.freeze({
      id: token.identity.id,
      clientGeneration: token.identity.clientGeneration,
      ownerGeneration: token.identity.ownerGeneration,
      deliveryToken: token.identity.deliveryToken,
      creditedEndSu: endSu
    }),
    onSettled: (result) => {
      if (settled) {
        return
      }
      settled = true
      if (!result.ok || token.state === 'closed' || endSu > token.ackQueuedEndSu) {
        return
      }
      token.ackPublishedEndSu = Math.max(token.ackPublishedEndSu, endSu)
      reclaimPublishedSourcePrefix(token, spanOwners)
      onPublished()
    }
  })
}
