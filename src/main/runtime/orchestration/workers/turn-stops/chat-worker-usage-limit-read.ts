import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** A chat worker's usage-limit stop as Orca's automatic continue sees it. */
export type ChatWorkerUsageLimit = {
  /** Orca's own automatic continues that led here; above zero, the limit was already reported. */
  chain: number
  resetsAt?: number
  /** When Orca continues the chat by itself; absent when it won't. */
  continuesAt?: number
}

/** Null when the chat ended on no usage limit, or its journal is unreadable. */
export async function readChatWorkerUsageLimit(
  sessionId: string
): Promise<ChatWorkerUsageLimit | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const cut = await (await host.journalReads(sessionId)).usageLimitCut()
    if (!cut) {
      return null
    }
    const state = host.usageLimitContinue.readState(sessionId, cut)
    const pending =
      state?.state === 'scheduled' &&
      (await host.usageLimitContinue.disposition(sessionId, cut.turnItemId)) === 'pending'
    return {
      chain: cut.chain,
      ...(cut.resetsAt !== undefined ? { resetsAt: cut.resetsAt } : {}),
      ...(pending ? { continuesAt: state.continueAt ?? state.resetsAt } : {})
    }
  } catch {
    return null
  }
}
