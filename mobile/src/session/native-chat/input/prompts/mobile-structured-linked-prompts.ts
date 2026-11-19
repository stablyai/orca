import type { StructuredAgentSessionState } from '../../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { MobileSessionItemLink } from '../../../mobile-session-item-target'
import {
  actionableStructuredApproval,
  actionableStructuredPrompts,
  actionableStructuredQuestion
} from './mobile-structured-actionable-prompt'

export function mobileStructuredLinkedPrompts(
  state: StructuredAgentSessionState,
  link: MobileSessionItemLink | undefined,
  sessionId: string | null
) {
  const preferred = link?.selection?.sessionId === sessionId ? link.selection.itemId : undefined
  const target = actionableStructuredPrompts(state).find((item) => item.itemId === preferred)
  const approvalPrompt = actionableStructuredApproval(state, target?.itemId)
  const questionPrompt = actionableStructuredQuestion(state, target?.itemId)
  const selected = approvalPrompt ?? questionPrompt
  return {
    approvalPrompt,
    questionPrompt,
    promptIdentity: selected
      ? { itemId: selected.itemId, expectedRevision: selected.revision }
      : undefined,
    navigation:
      link?.navigation?.target.sessionId === sessionId
        ? {
            ...link.navigation,
            pendingPrompt: selected?.itemId === link.navigation.target.itemId
          }
        : null
  }
}
