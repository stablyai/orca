// Native agent CLIs (chat providers, app servers) run outside terminals, under main or the agent host.
// One per live registration, so a reused pid's late release can't touch its successor.
type AgentRegistration = { chats: Set<string> }
const roots = new Map<number, Set<AgentRegistration>>()
// The CLI's own pid, which chats record, to its newest registration under the root whose tree is counted.
const registrationByAgentPid = new Map<number, AgentRegistration>()

/** Counts this root's process tree as agent memory until the returned release runs. */
export function registerAgentProcess(rootPid: number, agentPid = rootPid): () => void {
  const registration: AgentRegistration = { chats: new Set<string>() }
  const registrations = roots.get(rootPid) ?? new Set<AgentRegistration>()
  registrations.add(registration)
  roots.set(rootPid, registrations)
  registrationByAgentPid.set(agentPid, registration)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    registrations.delete(registration)
    if (registrations.size === 0 && roots.get(rootPid) === registrations) {
      roots.delete(rootPid)
    }
    if (registrationByAgentPid.get(agentPid) === registration) {
      registrationByAgentPid.delete(agentPid)
    }
  }
}

/** Names the chat this run started on a live agent process; it is forgotten with the registration. */
export function noteAgentProcessChat(agentPid: number, agentSessionId: string): void {
  registrationByAgentPid.get(agentPid)?.chats.add(agentSessionId)
}

/** Each live root with the one chat it belongs to; a root shared by several chats belongs to none. */
export function listAgentProcessRoots(): { pid: number; agentSessionId: string | null }[] {
  return [...roots].map(([pid, registrations]) => {
    let only: string | null = null
    for (const registration of registrations) {
      for (const chat of registration.chats) {
        if (only !== null && only !== chat) {
          return { pid, agentSessionId: null }
        }
        only = chat
      }
    }
    return { pid, agentSessionId: only }
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
