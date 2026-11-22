// Native agent CLIs (chat providers, app servers) run outside terminals, under main or the agent host.
type AgentRegistration = {
  chats: Set<string>
  release: () => void
  isLive: () => boolean
  sequence: number
}
let registrationSequence = 0
// Live runs hold distinct pids (each root is its own wrapper or CLI), so a pid already held belongs to an exited run.
const registrationByRoot = new Map<number, AgentRegistration>()
// The CLI's own pid, which chats record, to the registration whose root tree is counted.
const registrationByAgentPid = new Map<number, AgentRegistration>()

/** Counts this root's process tree as agent memory until the returned release runs, while `isLive` holds. */
export function registerAgentProcess(
  rootPid: number,
  agentPid = rootPid,
  isLive: () => boolean = () => true
): () => void {
  // A pid held as a root belongs to an exited run; one held only as a CLI pid may sit under a live root.
  for (const pid of new Set([rootPid, agentPid])) {
    registrationByRoot.get(pid)?.release()
  }
  const registration: AgentRegistration = {
    chats: new Set<string>(),
    isLive,
    sequence: ++registrationSequence,
    release: () => {
      if (registrationByRoot.get(rootPid) === registration) {
        registrationByRoot.delete(rootPid)
      }
      if (registrationByAgentPid.get(agentPid) === registration) {
        registrationByAgentPid.delete(agentPid)
      }
    }
  }
  registrationByRoot.set(rootPid, registration)
  registrationByAgentPid.set(agentPid, registration)
  return registration.release
}

/** Names the chat this run started on a live agent process; it is forgotten with the registration. */
export function noteAgentProcessChat(agentPid: number, agentSessionId: string): void {
  registrationByAgentPid.get(agentPid)?.chats.add(agentSessionId)
}

/** Marks the registrations that exist now; read it before enumerating processes. */
export function agentRegistrationMark(): number {
  return registrationSequence
}

/**
 * Each live root with the one chat it belongs to; a root linked to several chats belongs to none.
 * Roots registered after `mark` are left out: a sample taken earlier may hold an exited run's row under a reused pid.
 */
export function listAgentProcessRoots(
  mark = Number.POSITIVE_INFINITY
): { pid: number; agentSessionId: string | null }[] {
  const roots: { pid: number; agentSessionId: string | null }[] = []
  for (const [pid, { chats, isLive, sequence }] of registrationByRoot) {
    // A run no chat has linked (a sign-in, a probe) isn't a chat agent, so it isn't counted.
    if (chats.size > 0 && sequence <= mark && isLive()) {
      const [only] = chats
      roots.push({ pid, agentSessionId: chats.size === 1 ? (only ?? null) : null })
    }
  }
  return roots
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
