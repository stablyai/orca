import { pendingStructuredSessionPrompts } from '../../../src/shared/structured-agent-session-message-projection'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type {
  StructuredApprovalItem,
  StructuredQuestionItem
} from './mobile-structured-agent-prompts'

type PromptState = Pick<
  StructuredAgentSessionState,
  'items' | 'currentRequests' | 'actionablePromptIds'
>

export function actionableStructuredPrompts(state: PromptState) {
  return pendingStructuredSessionPrompts({
    journalItems: state.items,
    currentRequests: state.currentRequests,
    actionablePromptIds: state.actionablePromptIds
  })
}

export function actionableStructuredApproval(state: PromptState): StructuredApprovalItem | null {
  return (
    actionableStructuredPrompts(state).find(
      (item): item is StructuredApprovalItem => item.body.kind === 'approval'
    ) ?? null
  )
}

export function actionableStructuredQuestion(state: PromptState): StructuredQuestionItem | null {
  return (
    actionableStructuredPrompts(state).find(
      (item): item is StructuredQuestionItem => item.body.kind === 'question'
    ) ?? null
  )
}
