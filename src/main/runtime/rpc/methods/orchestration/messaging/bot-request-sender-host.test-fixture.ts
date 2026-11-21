import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** A session host whose store holds these open, host-local chats, as a running Orca's does. */
export function installSenderHost(
  sessionIds: string[],
  /** What every chat's usage-limit continue reads. */
  status?: { usageLimitContinue: { state: 'scheduled' } },
  /** Chats /clear continued in a session, by id; that session may have no record. */
  clearedInto: Record<string, string> = {}
): void {
  const conversations = sessionIds.map((sessionId) => ({
    sessionId,
    location: { executionHostId: 'local' },
    providerHandleChain: [],
    ...(clearedInto[sessionId]
      ? {
          conversationCommand: {
            command: 'clear',
            phase: 'committed',
            replacementSessionId: clearedInto[sessionId]
          }
        }
      : {})
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sender resolution reads only the host's record store and usage-limit continue.
  setStructuredAgentSessionHost({
    readUsageLimitContinue: async () => status?.usageLimitContinue,
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
