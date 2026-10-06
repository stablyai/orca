/**
 * Who the mail a chat is pointed at is from: every distinct sender, named the
 * way orchestration names a party, and each message's own sender and records. The run, dispatch
 * and message ids join back to orchestration's own rows while those exist.
 */

import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import type {
  AgentMessageSource,
  AgentMessageSender
} from '../../../shared/agent-session-message-source'
import type { MessageRow, OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'

export type MailSourceMessage = Pick<MessageRow, 'id' | 'from_handle' | 'run_id'>

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  batch: readonly MailSourceMessage[]
}): AgentMessageSource {
  const senders = new Map<string, AgentMessageSender>()
  for (const { from_handle: address } of input.batch) {
    if (!senders.has(address)) {
      senders.set(address, { party: senderParty(address, input.db) })
    }
  }
  return {
    kind: 'agent',
    senders: [...senders.values()],
    orchestration: {
      message: 'mail-notice',
      mailbox: input.mailboxHandle,
      dispatchId: input.dispatchId,
      messages: input.batch.map((message) => ({
        messageId: message.id,
        runId: message.run_id,
        from: message.from_handle
      }))
    }
  }
}

function senderParty(address: string, db: OrchestrationDb | null): AgentMessageSender['party'] {
  try {
    const { paneKey: _credential, ...party } = resolveOrchestrationParty(address, db)
    return party
  } catch {
    // A worker this host lost the identity of: what the address itself says.
    return { address, terminalHandle: null, orcaSessionId: parseOrcaSessionAddress(address) }
  }
}
