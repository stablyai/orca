import { isActionableStructuredAgentSessionPrompt } from '../../../src/shared/structured-agent-session-live-turn'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion,
  type StructuredApprovalItem,
  type StructuredQuestionItem
} from './mobile-structured-agent-prompts'

type PromptState = Pick<StructuredAgentSessionState, 'items' | 'actionablePromptIds'>

/** The approval a person can answer: pending, and named by the host as waiting when it names them
 *  (`isActionableStructuredAgentSessionPrompt`): one an agent that ended raised is not. */
export function actionableStructuredApproval(state: PromptState): StructuredApprovalItem | null {
  return (
    state.items.find(
      (item): item is StructuredApprovalItem =>
        pendingStructuredApproval(item) &&
        isActionableStructuredAgentSessionPrompt(item.itemId, state.actionablePromptIds)
    ) ?? null
  )
}

/** The question a person can answer, by the same rule. */
export function actionableStructuredQuestion(state: PromptState): StructuredQuestionItem | null {
  return (
    state.items.find(
      (item): item is StructuredQuestionItem =>
        pendingStructuredQuestion(item) &&
        isActionableStructuredAgentSessionPrompt(item.itemId, state.actionablePromptIds)
    ) ?? null
  )
}
