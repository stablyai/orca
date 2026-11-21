import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import type { ConnectorFailure } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../native-chat/agent-session-journal/projection/journal-dispatch-doubt-reasons'
import { connectorFailure } from './external-conversation-failure'
import type { ReplyExpiries } from './external-conversation-reply-expiry'
import { coversRow, type SettlePass } from './external-conversation-reply-settle-pass'
import { settledTurnVerdict } from './external-conversation-restart-binding'

type Row = JournalConnectorReplyRow

/**
 * Rows no turn answered, settled by the journal's own evidence before any turn opened (design item
 * 125 §3): a typed rejection failed; a provider that exited before taking the send (death
 * settlement) interrupted it, unless a continuation may still resume that send. That evidence wins
 * over position; otherwise a delivered message no ended turn's evidence claimed was answered with the
 * turns around it (O8). Anything else stays unfilled and watched (O3). Each fill that would post is
 * closed quietly instead when too old (design: slack-reply-lost-restart).
 */
export async function fillByEvidence(input: {
  journal: ConnectorReplyJournal
  pass: SettlePass
  /** The turns that could have answered a row, in order. */
  turns: readonly AgentJournalRenderItem[]
  /** Requests a turn with no verdict yet, or one waiting on its continuation, claims. */
  unresolved: readonly AgentJournalConnectorDelivery[]
  expiries: ReplyExpiries
  agentName: string
}): Promise<void> {
  const { journal, pass, turns, unresolved, expiries, agentName } = input
  const { snapshot } = pass
  const claimed = (row: Row) => unresolved.some((stamp) => coversRow(stamp, row))
  const idle = !turns.some((turn) => readAgentJournalTurn(turn.body)?.state === 'running')
  const lastEnded = Math.max(
    0,
    ...turns.filter((turn) => settledTurnVerdict(turn)).map((turn) => turn.sequence)
  )
  const sendOf = (row: Row) => {
    const message = pass.messageOf(row)
    const submission = snapshot.submissions.find(
      (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === message?.itemId
    )
    return { message, submission }
  }
  const evidence = (row: Row) => {
    const { message, submission } = sendOf(row)
    if (submission && !submission.answeredInTurn) {
      if (submission.dispatchState === 'rejected') {
        return 'failed' as const
      }
      if (
        submission.dispatchState === 'unknown' &&
        submission.recovered === true &&
        submission.reason === DISPATCH_DOUBT_PROVIDER_EXITED
      ) {
        return message && pass.sendHeld(message, submission) ? null : ('interrupted' as const)
      }
    }
    const at = pass.messageOf(row)?.sequence ?? 0
    // Unclaimed only by what this pass could read: an unreadable opener proves nothing.
    return idle && !pass.unknown && !claimed(row) && at > 0 && at < lastEnded
      ? ('unattributed' as const)
      : null
  }
  const left = (await journal.read(pass.sessionId)).filter((row) => !row.fill)
  // A typed rejection says why, as the live end would.
  const rejection = (row: Row): ConnectorFailure | undefined => {
    const fact = readAgentSessionFailureFact(sendOf(row).submission?.rejection)
    return fact && connectorFailure(fact, agentName)
  }
  const resolvedAt = (row: Row) => {
    const { message, submission } = sendOf(row)
    return submission?.resolvedAt ?? message?.observedAt
  }
  for (const outcome of ['failed', 'interrupted', 'unattributed'] as const) {
    await expiries.fillOrExpire(
      journal,
      left.filter((row) => evidence(row) === outcome),
      outcome,
      {
        // Answered with other turns, it is never posted on its own, so never too old.
        resolvedAt: outcome === 'unattributed' ? null : resolvedAt,
        admittedAt: (row) => pass.admittedAt(row)
      },
      outcome === 'failed' ? rejection : undefined
    )
  }
}
