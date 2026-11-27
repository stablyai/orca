import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { clearSuccessor } from './agent-session-sender-identity-revision'

/** Sessions a committed /clear continued into each one, derived from every held conversation
 *  (unreadable leases still count) and rebuilt only when lineage changes. */
export class AgentSessionClearedFromIndex {
  private built: { lineage: object; predecessors: Map<string, string[]> } | undefined

  constructor(
    private readonly source: {
      conversations: () => readonly Pick<
        AgentSessionConversationView,
        'sessionId' | 'conversationCommand'
      >[]
      lineage: () => object
    }
  ) {}

  clearedFrom = (sessionId: string): string[] => {
    const lineage = this.source.lineage()
    if (this.built?.lineage !== lineage) {
      const predecessors = new Map<string, string[]>()
      for (const conversation of this.source.conversations()) {
        const successor = clearSuccessor(conversation)
        if (successor !== null) {
          predecessors.set(successor, [
            ...(predecessors.get(successor) ?? []),
            conversation.sessionId
          ])
        }
      }
      this.built = { lineage, predecessors }
    }
    return [...(this.built.predecessors.get(sessionId) ?? [])]
  }

  /** The chat a run of /clears started from. */
  rootOf = (sessionId: string): string => {
    let root = sessionId
    const seen = new Set([root])
    for (
      let back = this.clearedFrom(root)[0];
      back && !seen.has(back);
      back = this.clearedFrom(root)[0]
    ) {
      seen.add(back)
      root = back
    }
    return root
  }
}
