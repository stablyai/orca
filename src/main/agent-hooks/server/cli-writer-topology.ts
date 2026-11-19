import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'

export type CliWriterTopology = NonNullable<AgentHookEventPayload['executionHost']>

/** OpenCode-family servers can outlive their pane; only the binding they posted can prove otherwise. */
export function cliWriterTopology(row: AgentHookEventPayload): CliWriterTopology {
  const topology = row.executionHost
  return topology === 'shared'
    ? 'shared'
    : row.source !== 'opencode' &&
        row.source !== 'opencode2' &&
        row.source !== 'mimo-code' &&
        row.payload.agentType !== 'opencode' &&
        row.payload.agentType !== 'opencode2'
      ? 'pane-owned'
      : topology === 'pane-owned'
        ? topology
        : 'unverifiable'
}
