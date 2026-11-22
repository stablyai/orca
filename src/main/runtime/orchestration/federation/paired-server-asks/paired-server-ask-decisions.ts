// A person's answer to a card on this computer or its phone: allow once, always allow the server,
// or deny. The first answer to find the card waiting wins.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { ClientAskPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import {
  admitPairedServerCard,
  allowServer,
  dropPairedServerAsk,
  getPairedServerAsk
} from '../../db/federation/paired-server-asks-store'
import { declinePairedServerAsk, safeJson } from './paired-server-ask-import'
import { admitPairedServerAsksNow } from './paired-server-asks-loop'

export type PairedServerDecision = 'once' | 'always' | 'deny'

/** A person's answer to a card; false when another answer got there first. */
export function decidePairedServerAsk(
  runtime: OrcaRuntimeService,
  messageId: string,
  decision: PairedServerDecision
): boolean {
  const db = runtime.getOrchestrationDb()
  // The card's change and what it causes commit together.
  const row = runLifecycleWriteTransaction(db.db, 'paired_server_decision', () => {
    const card = getPairedServerAsk(db, messageId)
    if (card?.state !== 'card') {
      return null
    }
    if (decision === 'deny') {
      if (!dropPairedServerAsk(db, messageId, 'card')) {
        return null
      }
      const ask = ClientAskPayload.safeParse(safeJson(card.payload))
      declinePairedServerAsk(runtime, db, {
        conversationId: card.conversation_id,
        messageId,
        to: ask.success ? ask.data.to : `bot:${card.bot_id}`,
        subject: ask.success ? ask.data.subject : 'Message'
      })
      return card
    }
    if (!admitPairedServerCard(db, messageId)) {
      return null
    }
    if (decision === 'always') {
      allowServer(db, {
        serverKey: card.server_key,
        botId: card.bot_id,
        environmentId: card.environment_id
      })
    }
    return card
  })
  if (!row) {
    return false
  }
  if (decision === 'deny') {
    return true
  }
  // Admitted now, connected or not; the loop starts so its answer goes back when it can.
  runtime.ensureOrchestrationPeerMailRelay(row.environment_id)
  admitPairedServerAsksNow(runtime, row.environment_id)
  return true
}
