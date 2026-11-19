import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'

// Execution metadata follows the conversation binding and disappears at serialization.
export const OPEN_CODE_WRITER_TOPOLOGY = Symbol('openCodeWriterTopology')

export type CliWriterTopology = 'pane-owned' | 'shared' | 'unverifiable'

/** OpenCode-family servers can outlive their pane; only the binding they posted can prove otherwise. */
export function cliWriterTopology(row: AgentHookEventPayload): CliWriterTopology {
  const binding = row.providerSession
  const topology =
    binding && OPEN_CODE_WRITER_TOPOLOGY in binding ? binding[OPEN_CODE_WRITER_TOPOLOGY] : undefined
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
