// Nonprimary threads identify children immediately; later revisions can add parent and run attribution.

import type {
  AgentJournalProducerLinkage,
  AgentJournalRowAttribution
} from '../../shared/agent-session-journal-types'
import type { CodexSubagentExecutions } from './codex-subagent-executions'

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
    // The primary thread must open before it can spawn children.
    if (primary === null || threadId === primary) {
      return {}
    }
    const spawner = this.deps.executions.spawnerOf(threadId)
    const attempt = turnId === null ? null : this.deps.executions.turnOrdinal(threadId, turnId)
    return {
      agentId: threadId,
      // Omit parentAgentId for root-owned children.
      ...(spawner !== null && spawner !== primary && spawner !== threadId
        ? { parentAgentId: spawner }
        : {}),
      producerKind: 'agent',
      ...(attempt !== null && attempt > 1 ? { attempt } : {})
    }
  }
}
