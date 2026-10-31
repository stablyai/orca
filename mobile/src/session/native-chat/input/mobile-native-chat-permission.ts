import type { AgentSessionFormContent } from '../../../../../src/shared/agent-session-form'
import type { ChatApproval } from '../../../../../src/shared/native-chat-interactive-prompt'

export type MobileChatPermission = ChatApproval & {
  formSubmitEnabled?: boolean
  /** Structured prompt identity, present only when the host can cancel it exactly. */
  prompt?: { itemId: string; expectedRevision: number }
}

export type MobilePermissionResponse = (
  send: string,
  content?: AgentSessionFormContent,
  rendered?: MobileChatPermission['prompt']
) => Promise<boolean>
