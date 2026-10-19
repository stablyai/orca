import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

/** Stops each running chat of `agent` on this host as a worktree teardown stops its chats; the chat
 *  stays, and its next send starts the agent again. Rejects unless every child is proven gone. */
export async function stopStructuredAgentChats(agent: string, label: string): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  const ids = host.loadedSessionIds().filter((id) => host.sessionAgent(id) === agent)
  // Every close settles before the caller's fence releases, even when one rejects.
  const closes = await Promise.allSettled(ids.map((id) => host.close(id, 'evict')))
  // A close that could not prove its child gone keeps it loaded.
  const stillLoaded = host.loadedSessionIds().some((id) => ids.includes(id))
  if (stillLoaded || closes.some((close) => close.status === 'rejected')) {
    throw new Error(`Not every ${label} chat on this host could be stopped. Try again.`)
  }
}
