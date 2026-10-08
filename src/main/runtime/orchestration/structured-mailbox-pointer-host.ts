/**
 * The structured-session half of the structured pointer lane.
 *
 * Keeps every `getStructuredAgentSessionHost()` call in one place so the delivery policy above it
 * stays pure and testable. Nothing here decides whether to deliver; it only performs the read and
 * the send and reports what the host said.
 */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerSessionFacts
} from './structured-mailbox-pointer-delivery'
import type {
  AgentJournalItemBody,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import type {
  StructuredPointerQueuedSend,
  StructuredPointerSubmission
} from './structured-pointer-operation-id'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import { sendAgentTurn } from './send-agent-turn'

/** Per-dispatch so one worker's nudges cannot exhaust the shared runtime operation-ledger budget. */
export function structuredPointerCallerKey(dispatchId: string): string {
  return `trusted-local:orchestration:${dispatchId}`
}

/**
 * The same budget for direct peer mail, which is addressed to the worker's own handle and has no
 * dispatch to scope to.
 *
 * A separate key rather than a reshaped one: the ledger is keyed on (callerKey, operationId), so
 * changing the dispatch key's shape would orphan every nudge already in flight under the old one.
 */
export function structuredSessionPointerCallerKey(sessionId: string): string {
  return `trusted-local:orchestration:session:${sessionId}`
}

/**
 * Whether a structured session is idle, for group addressing (`@idle`), read off its FULL reduced
 * timeline.
 *
 * Never a bounded page. A settled turn's lifecycle item is revised in place, so on any tail window
 * an idle session and a busy one whose lifecycle item scrolled off look identical — and
 * idle-with-history is the normal steady state of a working agent.
 */
export async function readStructuredSessionGateFacts(
  sessionId: string
): Promise<StructuredSessionGateFacts | null> {
  const snapshot = await readSessionJournal(sessionId)
  return snapshot ? structuredSessionGateFacts(snapshot.items) : null
}

/** What each recorded send settled as. */
async function readPointerSessionFacts(
  sessionId: string
): Promise<StructuredPointerSessionFacts | null> {
  const state = await readSession(sessionId, (host) => host.mailboxPointerSnapshot(sessionId))
  if (!state) {
    return null
  }
  const { snapshot, queuedMessages } = state
  const items = new Map(snapshot.items.map((item) => [item.itemId, item]))
  const queuedSends = new Map<string, StructuredPointerQueuedSend>()
  const queuedRows = new Map(queuedMessages.map((row) => [row.messageId, row]))
  const handoffSequences = new Map<string, number>()
  for (const row of queuedMessages) {
    const mailNotice = readMailNotice(row.body)
    queuedSends.set(row.messageId, {
      operationId: row.messageId,
      ...(mailNotice ? { mailNotice } : {}),
      ...(row.state === 'withdrawn' ? { settled: true as const } : {})
    })
  }
  const settledTurns = new Set<string>()
  const settledOpeners = new Set<string>()
  for (const item of snapshot.items) {
    const turn = readAgentJournalTurn(item.body)
    if (
      isRootAgentJournalItem(item) &&
      (turn?.state === 'completed' || turn?.state === 'interrupted')
    ) {
      settledTurns.add(item.itemId)
      if (turn.userItemId) {
        settledOpeners.add(turn.userItemId)
      }
    }
  }
  return {
    submissions: snapshot.submissions.map((submission) => {
      const submissionKey = agentJournalSubmissionKey(submission.clientMessageId)
      const item = items.get(submissionKey)
      const mailNotice = readMailNotice(item?.body)
      const turnSettled =
        settledOpeners.has(submissionKey) ||
        (submission.providerItemId !== null && settledOpeners.has(submission.providerItemId)) ||
        (item?.turnScope?.kind === 'turn' && settledTurns.has(item.turnScope.turnItemId))
      if (submission.queuedMessageId) {
        const operationId = submission.queuedMessageId
        const previous = queuedSends.get(operationId)
        const notice = previous?.mailNotice ?? mailNotice
        const draft = queuedRows.get(operationId)
        const sequence = submission.submittedSequence ?? 0
        const latest = sequence >= (handoffSequences.get(operationId) ?? -1)
        const settled = latest
          ? draft?.state === 'withdrawn' ||
            (!draft && submission.dispatchState === 'rejected') ||
            ((!draft ||
              (draft.state === 'dispatched' && draft.consumedAs === submission.clientMessageId)) &&
              turnSettled)
          : previous?.settled
        if (latest) {
          handoffSequences.set(operationId, sequence)
        }
        // A fresh handoff still names its original card after retention prunes the row.
        queuedSends.set(operationId, {
          operationId,
          ...(notice ? { mailNotice: notice } : {}),
          ...(settled ? { settled: true as const } : {})
        })
      }
      return {
        ...submission,
        ...(turnSettled ? { turnSettled: true as const } : {}),
        ...(mailNotice ? { mailNotice } : {})
      }
    }),
    queuedSends: [...queuedSends.values()]
  }
}

function readMailNotice(
  body: AgentJournalItemBody | undefined
): StructuredPointerSubmission['mailNotice'] {
  const notice = body?.kind === 'message' && body.role === 'user' ? body.from?.orchestration : null
  return notice?.message === 'mail-notice'
    ? { mailbox: notice.mailbox, messageIds: notice.messages.map((message) => message.messageId) }
    : undefined
}

function readSessionJournal(sessionId: string): Promise<AgentJournalSnapshot | null> {
  return readSession(sessionId, (host) => host.journalSnapshot(sessionId))
}

async function readSession<T>(
  sessionId: string,
  read: (host: StructuredAgentSessionHost) => Promise<T>
): Promise<T | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    // Opens a conversation the idle sweep closed; that starts no agent.
    return await read(host)
  } catch (error) {
    // Not attached is a retain reason, not a failure; anything else is still unreadable.
    if (!(error instanceof Error && error.message === AGENT_SESSION_NOT_ATTACHED.code)) {
      console.warn('[orchestration] structured journal unreadable', sessionId, error)
    }
    return null
  }
}

export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  return {
    readSessionFacts(sessionId) {
      return readPointerSessionFacts(sessionId)
    },

    currentFence(sessionId) {
      return (
        getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null
      )
    },

    async send(input) {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      const outcome = await sendAgentTurn({
        kind: 'structured-session',
        host,
        sessionId: input.sessionId,
        callerKey: input.dispatchId
          ? structuredPointerCallerKey(input.dispatchId)
          : structuredSessionPointerCallerKey(input.sessionId),
        turn: {
          body: input.body,
          // As a person's message is: a busy chat queues it as a card, sent when the turn ends.
          delivery: 'queue',
          operationId: input.operationId,
          expectedRuntimeFence: input.expectedRuntimeFence
        }
      })
      switch (outcome.kind) {
        case 'refused':
          return outcome.refusal.code === AGENT_SESSION_NOT_ATTACHED.code
            ? { kind: 'unattached' }
            : { kind: 'sent', state: 'rejected' }
        case 'queued':
          return { kind: 'queued' }
        case 'sent': {
          // `pending` is not yet an acknowledgement; only `accepted` may consume mail. A send still
          // pending after the wait parks for the next journal edge.
          const state = outcome.submission?.dispatchState
          return {
            kind: 'sent',
            state: state === 'accepted' ? 'accepted' : state === 'rejected' ? 'rejected' : 'unknown'
          }
        }
      }
    }
  }
}
