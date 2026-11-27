// How a provider moves a running chat between permission modes.

import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'

export type StructuredAgentSessionAdapterPermission = {
  permissionModeRequiresAcquisition?(
    sessionId: string,
    mode: AgentChatPermissionChoice
  ): boolean | undefined
  /** Move the running child to a picked mode now where the agent can; others take it at the next send. */
  applyPermissionMode?(input: {
    sessionId: string
    fence: number
    mode: AgentChatPermissionChoice
  }): Promise<void>
  /** A pick saved while the child starts (it is handed over at ready): a provider whose
   *  auto-approval would outrun that handover withdraws it now. */
  permissionPickedWhileStarting?(input: {
    sessionId: string
    mode: AgentChatPermissionChoice
  }): void
  /** The mode the running child applies now, when that can differ from the mode it launched with. */
  runningPermissionMode?(sessionId: string): AgentChatPermissionChoice | undefined
  /** Settle native work without withdrawing previously admitted input; false proves no permission transition. */
  settlePermissionTransition?(input: {
    sessionId: string
    fence: number
    mode: AgentChatPermissionChoice
    signal?: AbortSignal
  }): Promise<boolean>
}
