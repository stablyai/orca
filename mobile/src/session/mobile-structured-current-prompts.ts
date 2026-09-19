import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion
} from './mobile-structured-agent-prompts'

export function selectMobileStructuredCurrentPrompts(state: StructuredAgentSessionState) {
  const controllable = (item: { itemId: string }): boolean =>
    state.status === 'ready' &&
    (!state.execution || state.execution.promptIds.includes(item.itemId))
  return {
    approvalPrompt: state.items.filter(pendingStructuredApproval).find(controllable) ?? null,
    questionPrompt: state.items.filter(pendingStructuredQuestion).find(controllable) ?? null
  }
}
