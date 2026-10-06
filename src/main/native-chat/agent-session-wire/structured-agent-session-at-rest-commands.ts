import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'

/** The `/` surface of a chat whose agent is not running, read where the provider reads its own on
 *  this host. `read` is undefined until known; `onChange` fires when it changes. */
export type StructuredAgentSessionAtRestCommands = {
  read(record: AgentSessionRecord): AgentSessionSlashCommand[] | undefined
  onChange(listener: () => void): () => void
}
