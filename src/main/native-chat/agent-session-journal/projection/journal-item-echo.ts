import { memoryJournalMap } from '../journal-memory-collections'
import type { JournalKeyedRead } from '../journal-keyed-storage'
import { getJournalInputOrder } from '../input-order/journal-input-order-registry'
import type { JournalReducerState } from './journal-reducer'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { isWriteFailureSubmission } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
/** Absent permits legacy inference; preserve unknown declarations without authorizing delivery recovery. */
export type JournalItemEcho = { echoOf?: unknown }

export function journalItemEchoFields(item: JournalItemEcho): JournalItemEcho {
  return Object.hasOwn(item, 'echoOf') ? { echoOf: item.echoOf ?? null } : {}
}

export function journalItemDeclaresEcho(
  declarations: JournalKeyedRead<string, unknown>,
  itemId: string,
  incoming: JournalItemEcho = {}
): boolean {
  return declarations.has(itemId) || Object.hasOwn(incoming, 'echoOf')
}

export function journalItemEchoRestatement(
  declarations: JournalKeyedRead<string, unknown>,
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
  return state.queries.echoClaimant(state, fingerprint, marker5)
}

/** The frozen restore fold uses the same claimant order, including marker-5 inference. */
export function memoryJournalEchoClaimant(
  state: JournalReducerState,
  fingerprint: string,
  marker5: boolean
): string | null {
  const contextSequence = state.queries.latestContextClearSequence(state)
  // Match equal payloads in send order; proven-undelivered legacy rows cannot claim later resend echoes.
  const owner = getJournalInputOrder(state)
  const eligible = owner
    ? [...memoryJournalMap(state.items).keys()]
        .flatMap((id) => {
          const input = owner.inputForItem(id)
          return input ? [input] : []
        })
        .sort(
          (a, b) => owner.inputOrdinal(a.clientMessageId) - owner.inputOrdinal(b.clientMessageId)
        )
    : [...memoryJournalMap(state.submissions).values()]
  const submission = eligible
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
