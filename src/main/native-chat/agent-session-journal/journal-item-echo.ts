import type { JournalReducerState } from './journal-reducer'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { isWriteFailureSubmission } from '../../../shared/structured-agent-session-dispatch-rejection'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session-context-clear'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
/** Absent permits legacy inference; preserve unknown declarations without authorizing delivery recovery. */
export type JournalItemEcho = { echoOf?: unknown }

export function journalItemEchoFields(item: JournalItemEcho): JournalItemEcho {
  return Object.hasOwn(item, 'echoOf') ? { echoOf: item.echoOf ?? null } : {}
}

export function journalItemDeclaresEcho(
  declarations: ReadonlyMap<string, unknown>,
  itemId: string,
  incoming: JournalItemEcho = {}
): boolean {
  return declarations.has(itemId) || Object.hasOwn(incoming, 'echoOf')
}

export function journalItemEchoRestatement(
  declarations: ReadonlyMap<string, unknown>,
  itemId: string
): JournalItemEcho {
  return declarations.has(itemId) ? { echoOf: declarations.get(itemId) } : {}
}

export function isProviderUserMessageEcho(
  itemId: string,
  body: AgentJournalRenderItem['body']
): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return (
    body.kind === 'message' &&
    body.role === 'user' &&
    identity !== null &&
    identity.provider !== 'orca'
  )
}

export function resolveJournalItemId(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body'],
  marker5 = false
): string {
  const aliased = state.aliases.get(itemId)
  if (aliased) {
    return aliased
  }
  const submissionId = journalEchoClaimant(state, itemId, body, marker5)
  if (!submissionId) {
    return itemId
  }
  state.aliases.set(itemId, submissionId)
  return submissionId
}

/** Find an echo's eligible submission without claiming it. */
export function journalEchoClaimant(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body'],
  marker5 = false
): string | null {
  if (
    !body ||
    journalItemDeclaresEcho(state.itemEchoes, itemId) ||
    !isProviderUserMessageEcho(itemId, body)
  ) {
    return null
  }
  const fingerprint = agentSessionSendBodyFingerprint(state.sessionId, body)
  const contextSequence = latestAgentSessionContextClearSequence(state.items.values())
  // Match equal payloads in send order; proven-undelivered legacy rows cannot claim later resend echoes.
  const submission = [...state.submissions.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .find(
      (candidate) =>
        (contextSequence === 0 || (candidate.acceptedSequence ?? 0) > contextSequence) &&
        candidate.dispatchState !== 'rejected' &&
        !isWriteFailureSubmission(candidate) &&
        candidate.payloadFingerprint === fingerprint &&
        (marker5
          ? state.items.get(agentJournalSubmissionKey(candidate.clientMessageId))?.revision === 0
          : !state.inputs.echoes.has(agentJournalSubmissionKey(candidate.clientMessageId)) &&
            state.items.has(agentJournalSubmissionKey(candidate.clientMessageId)))
    )
  return submission ? agentJournalSubmissionKey(submission.clientMessageId) : null
}
