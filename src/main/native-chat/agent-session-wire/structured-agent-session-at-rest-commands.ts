import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'

export type AtRestCommandChange = { retired: (record: AgentSessionRecord) => boolean }

/** Read resting commands on their execution host; undefined until known, onChange when changed. */
export type StructuredAgentSessionAtRestCommands = {
  retireContext?(workspaceId?: string): void
  dispose?(): void
  closeAll?(): Promise<void>
  snapshot?(record: AgentSessionRecord): {
    commands?: AgentSessionSlashCommand[]
    commandsPending: boolean
    retryableFailure?: boolean
  }
  read(record: AgentSessionRecord): AgentSessionSlashCommand[] | undefined
  onChange(listener: (change?: AtRestCommandChange) => void): () => void
  /** Follow owner changes within one shared read deadline. */
  settled?(
    record: AgentSessionRecord,
    budgetMs: number,
    independent?: boolean
  ): Promise<AgentSessionSlashCommand[] | undefined>
}
