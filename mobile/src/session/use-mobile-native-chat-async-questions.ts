import { useCallback, useMemo, useReducer } from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type {
  NativeChatAsyncQuestionEdit,
  NativeChatAsyncQuestionEdits
} from '../../../src/shared/native-chat-async-question-answers'
import {
  nativeChatAsyncAnswerProgress,
  type NativeChatAsyncAnswerRecord
} from '../../../src/shared/native-chat-async-answer-progress'
import {
  createNativeChatAsyncQuestionCardState,
  nativeChatAsyncQuestionScopeView,
  reduceNativeChatAsyncQuestionCard,
  submitNativeChatAsyncQuestionScope,
  type NativeChatAsyncAnswerSendResult,
  type NativeChatAsyncAnswerSent
} from '../../../src/shared/native-chat-async-question-card-state'
import type {
  NativeChatAsyncQuestion,
  NativeChatAsyncQuestionsView
} from '../../../src/shared/native-chat-async-questions'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  mobileNativeChatAnswerEchoHolding,
  type MobileNativeChatPendingMessage
} from './mobile-native-chat-pending-echo'

export type MobileNativeChatAsyncQuestionsModel = {
  open: NativeChatAsyncQuestion[]
  omittedCount: number
  edits: NativeChatAsyncQuestionEdits
  /** Questions whose sent answer is still on its way: shown read-only. */
  held: ReadonlySet<string>
  sending: boolean
  canSend: boolean
  edit: (key: string, edit: NativeChatAsyncQuestionEdit) => void
  dismiss: (key: string) => void
  submit: () => void
}

type SubmissionState = Pick<AgentJournalSubmission, 'dispatchState' | 'recovered'>

/** Where a structured answer stands, read from its journal submission: on its way while the host
 *  waits for the agent to record it, given back once refused (a Stop before the agent drained it
 *  included) or outlived by its writer, and done once accepted or no longer known. */
function structuredAnswerRecord(
  sent: NativeChatAsyncAnswerSent,
  submission: SubmissionState | undefined
): NativeChatAsyncAnswerRecord | null {
  if (!submission || submission.dispatchState === 'accepted') {
    return null
  }
  const holding =
    submission.dispatchState === 'pending' ||
    (submission.dispatchState === 'unknown' && !submission.recovered)
  return { answers: sent.answers, holding }
}

/**
 * Controller-owned async question card state (it survives the chat↔terminal toggle), keyed
 * by question. Send goes through the active lane's answer seam — the terminal write lock or
 * the structured bridge — and never touches the composer draft. A delivered answer is held by
 * the lane's own record until the agent has it: the terminal echo, or the journal submission.
 */
export function useMobileNativeChatAsyncQuestions(args: {
  /** Session tab + chat session: edits never carry over to another conversation. */
  scopeKey: string
  view: NativeChatAsyncQuestionsView
  structured: boolean
  answerTerminal: (
    text: string,
    answers: Readonly<Record<string, string>>
  ) => Promise<NativeChatAsyncAnswerSendResult>
  answerStructured: (text: string) => Promise<NativeChatAsyncAnswerSendResult>
  /** This conversation's terminal echoes; one carrying answers holds them until its row lands. */
  pending: readonly MobileNativeChatPendingMessage[]
  /** The transcript the echoes land in, by which an echo that never will is let go. */
  messages: readonly NativeChatMessage[]
  /** The structured journal's submissions, by which a sent answer's hold is read. */
  submissions: readonly AgentJournalSubmission[]
}): MobileNativeChatAsyncQuestionsModel {
  const { scopeKey, view, structured, answerTerminal, answerStructured } = args
  const { pending, messages, submissions } = args
  const [state, dispatch] = useReducer(
    reduceNativeChatAsyncQuestionCard,
    createNativeChatAsyncQuestionCardState(scopeKey, view)
  )
  // Render-time adjustment: a new scope starts clean; an authoritative set prunes.
  if (state.scopeKey !== scopeKey || state.view !== view) {
    dispatch({ type: 'observe', scopeKey, view })
  }
  const submissionsById = useMemo(
    () => new Map(submissions.map((submission) => [submission.clientMessageId, submission])),
    [submissions]
  )
  // An accepted send is the agent's from then on; its answers wait only for the host's set.
  const accepted = state.sent.filter(
    (sent) => submissionsById.get(sent.receipt)?.dispatchState === 'accepted'
  )
  if (accepted.length > 0) {
    dispatch({ type: 'forget', receipts: new Set(accepted.map((sent) => sent.receipt)) })
  }
  const progress = useMemo(
    () =>
      nativeChatAsyncAnswerProgress([
        ...pending.flatMap((echo) =>
          echo.asyncAnswers
            ? [
                {
                  answers: echo.asyncAnswers,
                  holding: mobileNativeChatAnswerEchoHolding(echo, messages)
                }
              ]
            : []
        ),
        ...state.sent.flatMap((sent) => {
          const record = structuredAnswerRecord(sent, submissionsById.get(sent.receipt))
          return record ? [record] : []
        })
      ]),
    [messages, pending, state.sent, submissionsById]
  )
  const card = nativeChatAsyncQuestionScopeView(state, state.view, progress)
  const edit = useCallback(
    (key: string, next: NativeChatAsyncQuestionEdit) => dispatch({ type: 'edit', key, edit: next }),
    []
  )
  const dismiss = useCallback((key: string) => dispatch({ type: 'dismiss', key }), [])
  const submit = (): void =>
    submitNativeChatAsyncQuestionScope(
      { scopeKey: state.scopeKey, ...card },
      dispatch,
      (text, answers) => (structured ? answerStructured(text) : answerTerminal(text, answers))
    )
  return {
    open: card.open,
    omittedCount: card.omittedCount,
    edits: card.edits,
    held: card.held,
    sending: card.sending,
    canSend: card.canSend,
    edit,
    dismiss,
    submit
  }
}
