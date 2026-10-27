import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

/** Stop every running chat child for this agent, rejecting unless all are proven gone; chats remain and next send restarts them. */
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
