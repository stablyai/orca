// Which turn a Codex row belongs to, stated when the row is written.
//
// A primary-thread row belongs to the turn it names: that turn's lifecycle record, or the
// conversation command that claimed it. A child thread has turns of its own that the timeline
// does not draw, so its rows belong to the primary turn running when they arrive — the work the
// user is watching — or to no turn once the primary is idle.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'

export class CodexJournalTurnScopes {
  constructor(
    private readonly deps: {
      /** Without it no turn record is keyed, so every row reads as the thread's. */
      sessionId: string | undefined
      primaryThreadId: () => string | null
      activeTurn: (threadId: string) => string | null
      /** The command turn's scope, for a primary turn carrying a conversation command. */
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
