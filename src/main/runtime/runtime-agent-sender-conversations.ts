import { createHash } from 'node:crypto'
import { isSameAgentProcess, type AgentProcessIdentity } from '../../shared/agent-process-presence'

/** Bounded like the hook server's own per-pane maps; eviction only loses a live link. */
const MAX_PANES = 1024
/** /clear continuations one process keeps provable; older cards beyond it lose their live link. */
const MAX_CONTINUATIONS = 16

/** A provider conversation as a public key: never the provider's own id, which resumes it. */
export function agentConversationIdentity(agent: string, session: string): string {
  const digest = createHash('sha256').update(`${agent}\0${session}`).digest('base64url')
  return `conversation:${digest.slice(0, 24)}`
}

type PaneConversation = {
  agent: string
  session: string
  process: AgentProcessIdentity | undefined
  /** This conversation first, then the ones the same process continued from. */
  chain: string[]
}

/** Which conversation each pane runs now, from its own hooks. A new session continues the old one
 *  only when the same agent process reports it (its /clear or compact); that proof exists only
 *  where the agent's hook names its process. */
export class AgentSenderConversations {
  private readonly byPane = new Map<string, PaneConversation>()
  generation = 0

  /** True when the pane's conversation changed. */
  observe(
    paneKey: string,
    agent: string,
    session: string,
    process: AgentProcessIdentity | undefined
  ): boolean {
    const previous = this.byPane.get(paneKey)
    if (previous?.agent === agent && previous.session === session) {
      previous.process ??= process
      return false
    }
    const identity = agentConversationIdentity(agent, session)
    const continued =
      previous?.agent === agent &&
      previous.process !== undefined &&
      process !== undefined &&
      isSameAgentProcess(previous.process, process)
    this.byPane.delete(paneKey)
    this.byPane.set(paneKey, {
      agent,
      session,
      process,
      chain: continued ? [identity, ...previous.chain].slice(0, MAX_CONTINUATIONS) : [identity]
    })
    while (this.byPane.size > MAX_PANES) {
      const oldest = this.byPane.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.byPane.delete(oldest)
    }
    this.generation++
    return true
  }

  /** The pane's current conversation first; empty when no hook has named one. */
  of(paneKey: string): readonly string[] {
    return this.byPane.get(paneKey)?.chain ?? []
  }
}
