import type { z } from 'zod'
import type { PeerMailRelayPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { peerMailSenderSnapshot } from '../../federation/peer-mail/peer-mail-sender-snapshot'

/** Mail a paired Orca sent here, by the queue item kind it arrived as. */
export type ImportedPeerItem =
  /** A reply in a peer-mail conversation this Orca opened. */
  | ({ kind: 'peer_mail' } & Pick<
      z.infer<typeof PeerMailRelayPayload>,
      'senderLabel' | 'body' | 'sender' | 'botAnswer'
    >)
  /** A message filed in the mailbox of a Run this Orca coordinates on that server. */
  | { kind: 'worker_mail'; from: string; body: string }

/** The one place that decides how an imported peer item is stored: its sender and body. */
export function presentImportedPeerItem(item: ImportedPeerItem): {
  from: string
  body: string
  payload?: string
  answerSenderSnapshot?: string
} {
  if (item.kind !== 'peer_mail') {
    return { from: item.from, body: item.body }
  }
  return {
    from: item.senderLabel,
    body: item.body,
    // A bot's answer carries what a local one does, so the asker reads it the same way.
    ...(item.botAnswer
      ? {
          payload: JSON.stringify({
            requestId: item.botAnswer.requestId,
            botAnswer: item.botAnswer.view
          })
        }
      : {}),
    answerSenderSnapshot: peerMailSenderSnapshot(item.senderLabel, item.sender)
  }
}
