import type { FederationRelayItemRow } from './types'
import { readMailDisplayReport } from '../../../shared/agent-session/mail-display-report'
import { readAnswerSenderRelayReport } from './answer-sender-relay-report'

export function federationRelayWireItem(row: FederationRelayItemRow) {
  const displayReport = readMailDisplayReport(row.display_report)
  const answerSenderReport = readAnswerSenderRelayReport(row.answer_sender_report)
  return {
    dispatch_id: row.dispatch_id,
    direction: row.direction,
    sequence: row.sequence,
    message_id: row.message_id,
    kind: row.kind,
    payload: row.payload,
    ...(displayReport ? { displayReport } : {}),
    ...(answerSenderReport ? { answerSenderReport } : {})
  }
}
