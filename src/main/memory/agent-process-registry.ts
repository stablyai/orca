// Native agent CLIs (chat providers, app servers) run outside terminals, under main or the agent host.
type AgentRoot = { count: number; chats: Set<string> }
const roots = new Map<number, AgentRoot>()
// The CLI's own pid, which chats record, to the root whose tree is counted (its owner wrapper).
const rootByAgentPid = new Map<number, number>()

/** Counts this root's process tree as agent memory until the returned release runs. */
export function registerAgentProcess(rootPid: number, agentPid = rootPid): () => void {
  const root = roots.get(rootPid) ?? { count: 0, chats: new Set<string>() }
  root.count += 1
  roots.set(rootPid, root)
  rootByAgentPid.set(agentPid, rootPid)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    root.count -= 1
    if (root.count === 0 && roots.get(rootPid) === root) {
      roots.delete(rootPid)
    }
    if (rootByAgentPid.get(agentPid) === rootPid) {
      rootByAgentPid.delete(agentPid)
    }
  }
}

/** Names the chat this run started on a live agent process; it is forgotten with the root. */
export function noteAgentProcessChat(agentPid: number, agentSessionId: string): void {
  const rootPid = rootByAgentPid.get(agentPid)
  if (rootPid !== undefined) {
    roots.get(rootPid)?.chats.add(agentSessionId)
  }
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
