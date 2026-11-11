import type { FederationRelayItemRow } from '../db/orchestration-records'
import { readAnswerSenderRelayReport } from '../mailbox/senders/answer-sender-relay-report'

export function federationRelayWireItem(row: FederationRelayItemRow) {
  const answerSenderReport = readAnswerSenderRelayReport(row.answer_sender_report)
  return {
    dispatch_id: row.dispatch_id,
    direction: row.direction,
    sequence: row.sequence,
    message_id: row.message_id,
    kind: row.kind,
    payload: row.payload,
    ...(answerSenderReport ? { answerSenderReport } : {})
  }
}
