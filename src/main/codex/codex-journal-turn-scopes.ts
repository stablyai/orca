// Child rows follow the active primary turn; their own turns are not drawn in the timeline.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'

export class CodexJournalTurnScopes {
  constructor(
    private readonly deps: {
      /** Without session identity, rows fall back to thread scope. */
      sessionId: string | undefined
      primaryThreadId: () => string | null
      activeTurn: (threadId: string) => string | null
      commandScope: (turnId: string) => AgentJournalTurnScope | null
    }
  ) {}

  scopeFor(threadId: string, turnId: string | null): AgentJournalTurnScope {
    const primary = this.deps.primaryThreadId()
    const primaryTurnId =
      primary === null ? null : threadId === primary ? turnId : this.deps.activeTurn(primary)
    if (primaryTurnId === null) {
      return AGENT_JOURNAL_THREAD_SCOPE
    }
    const { sessionId } = this.deps
    return (
      this.deps.commandScope(primaryTurnId) ??
      (sessionId === undefined
        ? AGENT_JOURNAL_THREAD_SCOPE
        : {
            kind: 'turn',
            turnItemId: agentJournalItemKey(codexTurnLifecycleIdentity(sessionId, primaryTurnId))
          })
    )
  }
}
