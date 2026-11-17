import { useMemo } from 'react'
import type { StructuredAgentSessionState } from '../../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from './mobile-structured-actionable-prompt'

/** The prompts a structured chat can answer now, and what refuses a command meanwhile. */
export function useMobileStructuredActionablePrompts(
  state: Pick<StructuredAgentSessionState, 'items' | 'currentRequests' | 'actionablePromptIds'>,
  turnId: string | null,
  queueSendsNext: boolean
) {
  const { items, currentRequests, actionablePromptIds } = state
  // Prefer host actionability: ended-agent prompts must receive no answer.
  const [approvalPrompt, questionPrompt] = useMemo(() => {
    const prompts = { items, currentRequests, actionablePromptIds }
    return [actionableStructuredApproval(prompts), actionableStructuredQuestion(prompts)] as const
  }, [items, currentRequests, actionablePromptIds])
  const commandRefusalCauses = useMemo(
    () => ({
      working: turnId !== null || queueSendsNext,
      prompt: approvalPrompt !== null || questionPrompt !== null
    }),
    [approvalPrompt, questionPrompt, queueSendsNext, turnId]
  )
  return { approvalPrompt, questionPrompt, commandRefusalCauses }
}
