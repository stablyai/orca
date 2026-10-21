// Who produced a Codex journal row, decided from the thread that carried it.
//
// Orca opens exactly one thread per app-server, so every other thread on the
// connection is one Codex spawned for a subagent. That settles WHETHER a row is
// a child's without waiting on anything: there is no root arm for another
// thread, announced or not, and its thread id is final from its first frame —
// unlike a tool-call reference, it is never re-minted. Only the parent and the
// run are learned from the roster's executions, and a later revision of the
// row picks them up when they arrive.

import type {
  AgentJournalProducerLinkage,
  AgentJournalRowAttribution
} from '../../shared/agent-session-journal-types'
import type { CodexSubagentExecutions } from './codex-subagent-executions'

/** Who produced a row one thread wrote within one of that thread's turns (null outside any),
 *  and which turn the row belongs to. Every Codex write site resolves through this. */
export type CodexRowAttribution = (
  threadId: string,
  turnId: string | null
) => AgentJournalRowAttribution

export class CodexSubagentLinkage {
  constructor(
    private readonly deps: {
      primaryThreadId: () => string | null
      executions: Pick<CodexSubagentExecutions, 'spawnerOf' | 'turnOrdinal'>
    }
  ) {}

  linkageFor = (threadId: string, turnId: string | null): AgentJournalProducerLinkage => {
    const primary = this.deps.primaryThreadId()
    // An unknown primary means the session's thread is still opening, and no
    // turn has run that could have spawned a child.
    if (primary === null || threadId === primary) {
      return {}
    }
    const spawner = this.deps.executions.spawnerOf(threadId)
    const attempt = turnId === null ? null : this.deps.executions.turnOrdinal(threadId, turnId)
    return {
      agentId: threadId,
      // Absent means the session's own agent spawned it, so only another child is named.
      ...(spawner !== null && spawner !== primary && spawner !== threadId
        ? { parentAgentId: spawner }
        : {}),
      producerKind: 'agent',
      ...(attempt !== null && attempt > 1 ? { attempt } : {})
    }
  }
}
