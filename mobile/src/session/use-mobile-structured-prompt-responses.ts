import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSessionPromptResult } from '../../../src/shared/agent-session-wire'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion,
  structuredApprovalResponseTarget,
  structuredQuestionResponseTarget
} from './mobile-structured-agent-prompts'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import {
  advanceGroupedQuestion,
  groupedQuestionPromptKey,
  type GroupedQuestionDraft
} from './mobile-structured-grouped-question'

/**
 * Answering the two durable prompt kinds. Kept beside the session hook rather than inside it
 * because grouped questions carry their own multi-step draft, which is state the rest of the
 * session does not touch.
 */
export function useMobileStructuredPromptResponses(args: {
  stateRef: { readonly current: StructuredAgentSessionState }
  sessionKey: string
  mutate: StructuredAgentSessionMutate
  onSendError: (message: string) => void
}): {
  groupedDraft: GroupedQuestionDraft | null
  respondPermission: (optionId: string) => Promise<boolean>
  respondQuestion: (answer: string) => Promise<boolean>
} {
  const { mutate, onSendError, sessionKey, stateRef } = args
  // Partially answered grouped question, held only until its last step is submitted.
  const [groupedDraft, setGroupedDraft] = useState<GroupedQuestionDraft | null>(null)
  const groupedDraftRef = useRef(groupedDraft)
  useLayoutEffect(() => {
    groupedDraftRef.current = groupedDraft
  }, [groupedDraft])
  useEffect(() => {
    setGroupedDraft(null)
  }, [sessionKey])

  const respondPermission = useCallback(
    async (optionId: string): Promise<boolean> => {
      const target = structuredApprovalResponseTarget(
        optionId,
        stateRef.current.items.find(pendingStructuredApproval) ?? null
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

  const respondQuestion = useCallback(
    async (answer: string): Promise<boolean> => {
      const prompt = stateRef.current.items.find(pendingStructuredQuestion) ?? null
      const grouped = prompt?.body.questions
        ? advanceGroupedQuestion({
            response: answer,
            questions: prompt.body.questions,
            draft: groupedDraftRef.current,
            promptKey: groupedQuestionPromptKey(prompt.itemId, prompt.revision)
          })
        : null
      if (grouped?.kind === 'advance') {
        setGroupedDraft(grouped.draft)
        return true
      }
      const target =
        grouped && prompt
          ? { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: grouped.optionId }
          : structuredQuestionResponseTarget(answer, prompt)
      if (!target) {
        return false
      }
      const result = await mutate<AgentSessionPromptResult>(
        'agentSession.respondToQuestion',
        'agentSession.respondTo:question',
        target
      )
      if (grouped && result.status !== 'rejected') {
        // The group left the phone; a retry must start from the first question, not a stale tail.
        setGroupedDraft(null)
      }
      if (result.status === 'unknown') {
        onSendError('Answer unconfirmed — check chat before retrying')
        return false
      }
      return result.status === 'accepted'
    },
    [mutate, onSendError, stateRef]
  )

  return { groupedDraft, respondPermission, respondQuestion }
}
