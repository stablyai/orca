import type {
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalReducerState } from './projection/journal-reducer'
import { journalInputOrder, type JournalInputOrder } from './input-order/journal-input-order'
import { memoryJournalMap } from './journal-memory-collections'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

/** One named input-evidence population; each answer is a plain record of the same kind. */
export type JournalInputSingleRead =
  | { kind: 'first-queued' }
  | { kind: 'latest-submission'; fence: number }
  | { kind: 'entered-submissions' }
  | { kind: 'sending-submissions' }
  | { kind: 'recoverable-submissions' }
  | { kind: 'pending-submissions' }
  | { kind: 'accepted-submissions' }
  | { kind: 'capture-keys'; present: readonly string[] }
  | { kind: 'unsettled-submissions' }
  | { kind: 'recovered-unknown-ids' }
  | { kind: 'linked-to'; messageId: string }
  | { kind: 'latest-accepted-handover' }
  | { kind: 'input-for-item'; itemId: string }
  | { kind: 'input-ordinal'; clientMessageId: string }
  | { kind: 'input-count' }
  | { kind: 'sent-after'; sequence: number }
  | { kind: 'accepted-after'; sequence: number }
  | { kind: 'accepted-inputs-after'; sequence: number }
  | { kind: 'signed-out-at'; fence: number }
  | { kind: 'submission-at'; sequence: number }
  | { kind: 'stopped-history-inputs'; excluding: string; afterSequence?: number }
  | { kind: 'newest-turn' }

/** A batch answers several reads from one snapshot, for a consumer that needs them coherent. */
export type JournalInputRead =
  | JournalInputSingleRead
  | { kind: 'batch'; reads: readonly JournalInputSingleRead[] }

type SubmissionsKind =
  | 'entered-submissions'
  | 'sending-submissions'
  | 'recoverable-submissions'
  | 'pending-submissions'
  | 'unsettled-submissions'
  | 'linked-to'
  | 'accepted-inputs-after'
  | 'stopped-history-inputs'

export type JournalInputSingleReadResult =
  | {
      kind: 'first-queued' | 'input-for-item' | 'submission-at' | 'latest-submission'
      submission: AgentJournalSubmission | undefined
    }
  | { kind: SubmissionsKind; submissions: AgentJournalSubmission[] }
  | {
      kind: 'accepted-submissions'
      submissions: AgentJournalSubmission[]
      latestReceiptSequence: number
    }
  | { kind: 'recovered-unknown-ids'; ids: string[] }
  /** Exact input-key membership at this read, including supplied rendered prompt keys. */
  | { kind: 'capture-keys'; keys: string[] }
  | { kind: 'latest-accepted-handover'; sequence: number }
  /** Infinity for an input this chat never recorded, as the ordinal index answers. */
  | { kind: 'input-ordinal'; ordinal: number }
  | { kind: 'input-count'; count: number }
  | { kind: 'sent-after' | 'accepted-after' | 'signed-out-at'; answer: boolean }
  | { kind: 'newest-turn'; turn: AgentJournalTurnLifecycle | null }

export type JournalInputReadResult =
  | JournalInputSingleReadResult
  | { kind: 'batch'; results: JournalInputSingleReadResult[] }

export type JournalInputAnswer<K extends JournalInputRead['kind']> =
  JournalInputReadResult extends infer R
    ? R extends { kind: infer RK }
      ? K extends RK
        ? R & { kind: K }
        : never
      : never
    : never

export type JournalInputReader = <K extends JournalInputRead['kind']>(
  operation: Extract<JournalInputRead, { kind: K }>
) => Promise<JournalInputAnswer<K>>

/** Detaches a value from its storage before it leaves the read; memory answers are already plain. */
export type JournalInputPlain = <T>(value: T) => T

export function readJournalInput<K extends JournalInputRead['kind']>(
  state: JournalReducerState,
  operation: Extract<JournalInputRead, { kind: K }>
): JournalInputAnswer<K>
export function readJournalInput(
  state: JournalReducerState,
  operation: JournalInputRead
): JournalInputReadResult {
  return answerJournalInput(journalInputOrder(state), operation, () =>
    Array.from(memoryJournalMap(state.submissions).keys(), agentJournalSubmissionKey)
  )
}

/** Read-only calls on the input owner's indexes; nothing here refreshes, ensures or writes. */
export function answerJournalInput(
  order: JournalInputOrder,
  operation: JournalInputRead,
  inputKeys: () => Iterable<string>,
  plain: JournalInputPlain = (value) => value
): JournalInputReadResult {
  if (operation.kind === 'batch') {
    return {
      kind: 'batch',
      results: operation.reads.map((read) => answerSingle(order, read, inputKeys, plain))
    }
  }
  return answerSingle(order, operation, inputKeys, plain)
}

function answerSingle(
  order: JournalInputOrder,
  operation: JournalInputSingleRead,
  inputKeys: () => Iterable<string>,
  plain: JournalInputPlain
): JournalInputSingleReadResult {
  const list = (submissions: Iterable<AgentJournalSubmission>) =>
    Array.from(submissions, (submission) => plain(submission))
  switch (operation.kind) {
    case 'latest-submission':
      return { kind: operation.kind, submission: plain(order.latestSubmission(operation.fence)) }
    case 'first-queued':
      return { kind: operation.kind, submission: plain(order.firstQueued()) }
    case 'entered-submissions':
      return { kind: operation.kind, submissions: list(order.enteredSubmissions()) }
    case 'sending-submissions':
      return { kind: operation.kind, submissions: list(order.sendingSubmissions()) }
    case 'recoverable-submissions':
      return { kind: operation.kind, submissions: list(order.recoverableSubmissions()) }
    case 'accepted-submissions':
      return {
        kind: operation.kind,
        submissions: list(order.acceptedInputsAfter(-Infinity)),
        latestReceiptSequence: order.latestReceiptSequence()
      }
    case 'capture-keys':
      return {
        kind: operation.kind,
        keys: [...new Set([...operation.present, ...inputKeys()])].sort()
      }
    case 'unsettled-submissions':
      return { kind: operation.kind, submissions: list(order.unsettledSubmissions()) }
    case 'pending-submissions':
      return {
        kind: operation.kind,
        submissions: list(
          order.unsettledSubmissions().filter((entry) => entry.dispatchState === 'pending')
        )
      }
    case 'recovered-unknown-ids':
      return { kind: operation.kind, ids: order.recoveredUnknownIds() }
    case 'linked-to':
      return { kind: operation.kind, submissions: list(order.linkedTo(operation.messageId)) }
    case 'latest-accepted-handover':
      return { kind: operation.kind, sequence: order.links.acceptedHandover() }
    case 'input-for-item':
      return { kind: operation.kind, submission: plain(order.inputForItem(operation.itemId)) }
    case 'input-ordinal':
      return { kind: operation.kind, ordinal: order.inputOrdinal(operation.clientMessageId) }
    case 'input-count':
      return { kind: operation.kind, count: order.inputCount() }
    case 'sent-after':
      return { kind: operation.kind, answer: order.sentAfter(operation.sequence) }
    case 'accepted-after':
      return { kind: operation.kind, answer: order.acceptedAfter(operation.sequence) }
    case 'accepted-inputs-after':
      return {
        kind: operation.kind,
        submissions: list(order.acceptedInputsAfter(operation.sequence))
      }
    case 'signed-out-at':
      return { kind: operation.kind, answer: order.signedOutAt(operation.fence) }
    case 'submission-at':
      return { kind: operation.kind, submission: plain(order.submissionAt(operation.sequence)) }
    case 'stopped-history-inputs':
      return {
        kind: operation.kind,
        submissions: list(order.stoppedHistoryInputs(operation.excluding, operation.afterSequence))
      }
    case 'newest-turn':
      return {
        kind: operation.kind,
        turn: readAgentJournalTurn(plain(order.newestTurn.read())?.body)
      }
  }
}
