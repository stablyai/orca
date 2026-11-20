// Native agent CLIs (chat providers, app servers) run outside terminals, under main or the agent host.
type AgentRoot = { count: number; chats: Set<string> }
const roots = new Map<number, AgentRoot>()

/** Counts this provider root's process tree as agent memory until the returned release runs. */
export function registerAgentProcess(pid: number): () => void {
  const root = roots.get(pid) ?? { count: 0, chats: new Set<string>() }
  root.count += 1
  roots.set(pid, root)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    root.count -= 1
    if (root.count === 0 && roots.get(pid) === root) {
      roots.delete(pid)
    }
  }
}

/** Names the chat this run started on a live root; it is forgotten with the root. */
export function noteAgentProcessChat(pid: number, agentSessionId: string): void {
  roots.get(pid)?.chats.add(agentSessionId)
}

/** Each live root with the one chat it belongs to; a root shared by several chats belongs to none. */
export function listAgentProcessRoots(): { pid: number; agentSessionId: string | null }[] {
  return [...roots].map(([pid, root]) => {
    const [only] = root.chats
    return { pid, agentSessionId: root.chats.size === 1 ? (only ?? null) : null }
  })
}

/** What the Resource Manager shows for a chat; null once its record is gone. */
export type AgentProcessChat = { worktreeId: string; agent: string; name: string | null }

// The chat host installs this, so the collector never imports the chat module graph.
let readChat: (agentSessionId: string) => AgentProcessChat | null = () => null

export function setAgentProcessChatReader(
  reader: (agentSessionId: string) => AgentProcessChat | null
): void {
  readChat = reader
}

export function readAgentProcessChat(agentSessionId: string): AgentProcessChat | null {
  return readChat(agentSessionId)
}
