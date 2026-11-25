// Native agent CLIs (chat providers, app servers) run outside terminals, under main or the agent host.
type AgentRegistration = {
  // Only zero, one or several chats matter, so a shared process never accumulates the ids of every chat it served.
  chat?: string
  shared: boolean
  release: () => void
  isLive: () => boolean
  sequence: number
}
let registrationSequence = 0
// Live runs hold distinct pids (each root is its own wrapper or CLI), so a pid already held belongs to an exited run.
const registrationByRoot = new Map<number, AgentRegistration>()
// The CLI's own pid, which chats record, to the registration whose root tree is counted.
const registrationByAgentPid = new Map<number, AgentRegistration>()
let linkedRegistrations = 0

/** Whether any registered agent process belongs to a chat, so a sample needs to walk agent trees. */
export function hasAgentProcessRegistrations(): boolean {
  return linkedRegistrations > 0
}

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
  let released = false
  const registration: AgentRegistration = {
    shared: false,
    isLive,
    sequence: ++registrationSequence,
    release: () => {
      if (!released && registration.chat !== undefined) {
        linkedRegistrations--
      }
      released = true
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
  const registration = registrationByAgentPid.get(agentPid)
  if (!registration) {
    return
  }
  if (registration.chat === undefined) {
    registration.chat = agentSessionId
    // A sample whose mark predates the link may have skipped the start times its tree walk needs.
    registration.sequence = ++registrationSequence
    linkedRegistrations++
  } else if (registration.chat !== agentSessionId) {
    registration.shared = true
  }
}

/** Marks the registrations that exist now; read it before enumerating processes. */
export function agentRegistrationMark(): number {
  return registrationSequence
}

/**
 * Each live root with the one chat it belongs to; a root linked to several chats belongs to none.
 * Roots registered or first linked after `mark` are left out: a sample taken earlier may hold an exited run's row under a reused pid.
 */
export function listAgentProcessRoots(
  mark = Number.POSITIVE_INFINITY
): { pid: number; agentSessionId: string | null }[] {
  const roots: { pid: number; agentSessionId: string | null }[] = []
  for (const [pid, { chat, shared, isLive, sequence }] of registrationByRoot) {
    // A run no chat has linked (a sign-in, a probe) isn't a chat agent, so it isn't counted.
    if (chat !== undefined && sequence <= mark && isLive()) {
      roots.push({ pid, agentSessionId: shared ? null : chat })
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
