import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** A chat worker's usage-limit stop as Orca's automatic continue sees it. */
export type ChatWorkerUsageLimit = {
  /** Orca still continues the chat by itself. */
  continues: boolean
  resetsAt?: number
  /** When it continues; absent while it waits for its account to show room. */
  continuesAt?: number
}

/** Read for the failed turn: a later or other cut never continues it. Null when unreadable. */
export async function readChatWorkerUsageLimit(
  sessionId: string,
  turnItemId: string
): Promise<ChatWorkerUsageLimit | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const [state, disposition] = await Promise.all([
      host.readUsageLimitContinue(sessionId),
      host.usageLimitContinue.disposition(sessionId, turnItemId)
    ])
    const known = state?.turnItemId === turnItemId ? state : undefined
    const continues = disposition === 'pending'
    return {
      continues,
      ...(known ? { resetsAt: known.resetsAt } : {}),
      ...(continues && known?.state === 'scheduled'
        ? { continuesAt: known.continueAt ?? known.resetsAt }
        : {})
    }
  } catch {
    return null
  }
}
