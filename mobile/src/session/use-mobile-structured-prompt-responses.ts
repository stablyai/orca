import { useCallback } from 'react'
import type { AgentSessionPromptResult } from '../../../src/shared/agent-session-wire'
import type { AgentJournalQuestionItem } from '../../../src/shared/agent-session-journal-types'
import {
  AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH,
  decodeAgentSessionQuestionAnswers,
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionSelectedOptionId,
  type AgentSessionQuestionAnswer
} from '../../../src/shared/agent-session-question-answer'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from './mobile-structured-actionable-prompt'
import {
  structuredApprovalResponseTarget,
  structuredQuestionResponseTarget
} from './mobile-structured-agent-prompts'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import type { MobileChatQuestion } from './native-chat/input/mobile-native-chat-question'

export function useMobileStructuredPromptResponses(args: {
  stateRef: { readonly current: StructuredAgentSessionState }
  mutate: StructuredAgentSessionMutate
  // Older hosts require answers packed into optionId.
  questionAnswersSupported: boolean | null
  onSendError: (message: string) => void
}): {
  respondPermission: (optionId: string) => Promise<boolean>
  respondQuestion: (answer: string, rendered?: MobileChatQuestion['prompt']) => Promise<boolean>
} {
  const { mutate, onSendError, questionAnswersSupported, stateRef } = args

  const respondPermission = useCallback(
    async (optionId: string): Promise<boolean> => {
      const target = structuredApprovalResponseTarget(
        optionId,
        actionableStructuredApproval(stateRef.current)
      )
      if (!target) {
        return false
      }
      const result = await mutate<AgentSessionPromptResult>(
        'agentSession.respondToApproval',
        'agentSession.respondTo:approval',
        target
      )
      if (result.status === 'unknown') {
        onSendError('Response unconfirmed — check chat before retrying')
        return false
      }
      return result.status === 'accepted'
    },
    [mutate, onSendError, stateRef]
  )

  const sendAnswers = useCallback(
    (
      target: { itemId: string; expectedRevision: number },
      body: Pick<AgentJournalQuestionItem, 'questions' | 'freeTextInput'>,
      answers: AgentSessionQuestionAnswer[]
    ): Promise<StructuredAgentSessionMutationResult<AgentSessionPromptResult> | null> => {
      const send = (fields: Record<string, unknown>) =>
        mutate<AgentSessionPromptResult>(
          'agentSession.respondToQuestion',
          'agentSession.respondTo:question',
          { ...target, ...fields }
        )
      if (questionAnswersSupported === true) {
        return send({ answers })
      }
      const optionId = legacyAgentSessionSelectedOptionId(body, answers)
      if (optionId === null) {
        return Promise.resolve(null)
      }
      if (optionId.length > AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH) {
        // Unknown support cannot justify packing an oversized answer; only structured answers can land.
        if (questionAnswersSupported === null) {
          return send({ answers })
        }
        onSendError('Update Orca on your computer to send answers this long')
        return Promise.resolve(null)
      }
      return send({ optionId })
    },
    [mutate, onSendError, questionAnswersSupported]
  )

  const respondQuestion = useCallback(
    async (answer: string, rendered?: MobileChatQuestion['prompt']): Promise<boolean> => {
      const prompt = actionableStructuredQuestion(stateRef.current)
      if (prompt?.body.questions) {
        // Claude reuses question ids across prompts, so answers must match the prompt they were picked on.
        const answers = decodeAgentSessionQuestionAnswers(answer)
        if (
          !answers ||
          rendered?.itemId !== prompt.itemId ||
          rendered.expectedRevision !== prompt.revision ||
          !isValidAgentSessionQuestionAnswers(prompt.body.questions, answers)
        ) {
          return false
        }
        const result = await sendAnswers(
          { itemId: prompt.itemId, expectedRevision: prompt.revision },
          prompt.body,
          answers
        )
        if (!result) {
          return false
        }
        if (result.status === 'unknown') {
          onSendError('Answer unconfirmed — check chat before retrying')
          return false
        }
        return result.status === 'accepted'
      }
      const target = structuredQuestionResponseTarget(answer, prompt)
      if (!target) {
        return false
      }
      const result = await sendAnswers(
        { itemId: target.itemId, expectedRevision: target.expectedRevision },
        prompt?.itemId === target.itemId ? prompt.body : {},
        [target.answer]
      )
      if (!result) {
        return false
      }
      if (result.status === 'unknown') {
        onSendError('Answer unconfirmed — check chat before retrying')
        return false
      }
      return result.status === 'accepted'
    },
    [onSendError, sendAnswers, stateRef]
  )

  return { respondPermission, respondQuestion }
}
