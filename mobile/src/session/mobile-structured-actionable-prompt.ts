import { selectAgentSessionCurrentRequests } from '../../../src/shared/agent-session-current-requests'
import { isActionableStructuredAgentSessionPrompt } from '../../../src/shared/structured-agent-session-live-turn'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion,
  type StructuredApprovalItem,
  type StructuredQuestionItem
} from './mobile-structured-agent-prompts'

type PromptState = Pick<
  StructuredAgentSessionState,
  'items' | 'currentRequests' | 'actionablePromptIds'
>

// Only pending prompts the host still marks actionable may receive answers; ended-agent prompts must not.
export function actionableStructuredApproval(state: PromptState): StructuredApprovalItem | null {
  return (
    selectAgentSessionCurrentRequests(state).find(
      (item): item is StructuredApprovalItem =>
        pendingStructuredApproval(item) &&
        isActionableStructuredAgentSessionPrompt(item.itemId, state.actionablePromptIds)
    ) ?? null
  )
}

export function actionableStructuredQuestion(state: PromptState): StructuredQuestionItem | null {
  return (
    selectAgentSessionCurrentRequests(state).find(
      (item): item is StructuredQuestionItem =>
        pendingStructuredQuestion(item) &&
        isActionableStructuredAgentSessionPrompt(item.itemId, state.actionablePromptIds)
    ) ?? null
  )
}
