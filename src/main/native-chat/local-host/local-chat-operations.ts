import type { terminalResumeOwnership } from '../agent-session-wire/host/structured-provider-session-ownership'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { createStructuredAgentSessionForWorktree } from '../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create'

type CreateChat = typeof createStructuredAgentSessionForWorktree
export type LocalChatOperations = Pick<
  AgentSessionRecordStore,
  | 'admitAndClaimOperation'
  | 'recordOperationOutcome'
  | 'listWorkspaceSessions'
  | 'workspaceAttentionReads'
> & {
  terminalResumeOwnership: (params: null) => ReturnType<typeof terminalResumeOwnership>
  createLaunchSession: (
    args: Omit<
      Parameters<CreateChat>[0],
      'runtime' | 'ensureHost' | 'signal' | 'beforeDelivery' | 'beforeFirstMessage'
    >
  ) => ReturnType<CreateChat>
}

export type LocalChatRequest = {
  [K in keyof LocalChatOperations]: {
    method: `localChat.${K}`
    params: Parameters<LocalChatOperations[K]>[0]
  }
}[keyof LocalChatOperations]
