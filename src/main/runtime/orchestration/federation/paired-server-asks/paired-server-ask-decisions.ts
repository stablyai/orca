// A person's answer to a card on this computer or its phone: allow once, always allow the server,
// or deny. The first answer to find the card waiting wins.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { ClientAskPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import {
  admitPairedServerCard,
  allowServer,
  dropPairedServerAsk,
  getPairedServerAsk
} from '../../db/federation/paired-server-asks-store'
import { declinePairedServerAsk } from './paired-server-ask-import'
import { admitPairedServerAsksNow } from './paired-server-asks-loop'
import { notifyPairedServerCardsChanged } from './paired-server-card-notices'

export type PairedServerDecision = 'once' | 'always' | 'deny'

/** A person's answer to a card; false when another answer got there first. */
export function decidePairedServerAsk(
  runtime: OrcaRuntimeService,
  messageId: string,
  decision: PairedServerDecision
): boolean {
  const db = runtime.getOrchestrationDb()
  const row = getPairedServerAsk(db, messageId)
  if (row?.state !== 'card') {
    return false
  }
  if (decision === 'deny') {
    if (!dropPairedServerAsk(db, messageId, 'card')) {
      return false
    }
    const ask = ClientAskPayload.safeParse(JSON.parse(row.payload))
    declinePairedServerAsk(runtime, db, {
      conversationId: row.conversation_id,
      messageId,
      to: ask.success ? ask.data.to : `bot:${row.bot_id}`,
      subject: ask.success ? ask.data.subject : 'Message'
    })
    notifyPairedServerCardsChanged(runtime, [row.bot_id])
    return true
  }
  if (!admitPairedServerCard(db, messageId)) {
    return false
  }
  if (decision === 'always') {
    allowServer(db, {
      serverInstallationId: row.server_installation_id,
      botId: row.bot_id,
      environmentId: row.environment_id
    })
  }
  // Admitted by the server's loop, which knows its pairing; started now rather than at its next pull.
  runtime.ensureOrchestrationPeerMailRelay(row.environment_id)
  admitPairedServerAsksNow(runtime, row.environment_id)
  notifyPairedServerCardsChanged(runtime, [row.bot_id])
  return true
}
