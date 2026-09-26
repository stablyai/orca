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
  /** Primary turns a conversation command claimed, to the command turn's journal key. */
  private readonly claims = new Map<string, string>()

  constructor(
    private readonly deps: {
      /** Without it no turn record is keyed, so every row reads as the thread's. */
      sessionId: string | undefined
      primaryThreadId: () => string | null
      activeTurn: (threadId: string) => string | null
    }
  ) {}

  scopeFor(threadId: string, turnId: string | null): AgentJournalTurnScope {
    const primary = this.deps.primaryThreadId()
    const primaryTurnId =
      primary === null ? null : threadId === primary ? turnId : this.deps.activeTurn(primary)
    const turnItemId = primaryTurnId === null ? null : this.turnItemId(primaryTurnId)
    return turnItemId === null ? AGENT_JOURNAL_THREAD_SCOPE : { kind: 'turn', turnItemId }
  }

  claim(turnId: string, commandTurnItemId: string): void {
    this.claims.set(turnId, commandTurnItemId)
  }

  claimed(turnId: string): boolean {
    return this.claims.has(turnId)
  }

  forget(turnId: string): void {
    this.claims.delete(turnId)
  }

  clear(): void {
    this.claims.clear()
  }

  private turnItemId(turnId: string): string | null {
    const claimed = this.claims.get(turnId)
    if (claimed !== undefined) {
      return claimed
    }
    const { sessionId } = this.deps
    return sessionId === undefined
      ? null
      : agentJournalItemKey(codexTurnLifecycleIdentity(sessionId, turnId))
  }
}
