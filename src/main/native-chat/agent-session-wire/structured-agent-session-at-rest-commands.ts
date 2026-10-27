import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'

/** Read resting commands on their execution host; undefined until known, onChange when changed. */
export type StructuredAgentSessionAtRestCommands = {
  retireContext?(workspaceId?: string): void
  dispose?(): void
  read(record: AgentSessionRecord): AgentSessionSlashCommand[] | undefined
  onChange(listener: () => void): () => void
  /** Follow owner changes within one shared read deadline. */
  settled?(
    record: AgentSessionRecord,
    budgetMs: number
  ): Promise<AgentSessionSlashCommand[] | undefined>
}
