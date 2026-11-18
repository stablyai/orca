import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** A session host whose store holds these open, host-local chats, as a running Orca's does. */
export function installSenderHost(sessionIds: string[]): void {
  const conversations = sessionIds.map((sessionId) => ({
    sessionId,
    location: { executionHostId: 'local' },
    providerHandleChain: []
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sender resolution reads only the host's record store.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        getConversation: (id: string) => conversations.find((c) => c.sessionId === id) ?? null,
        listConversations: () => conversations,
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds })
      }
    }
  } as never)
}

export function removeSenderHost(): void {
  setStructuredAgentSessionHost(null)
}
