import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export type StructuredAgentSessionConversationLifetimeHost = {
  /** Resolve lazily because host collaborators are assigned after construction. */
  context: () => StructuredAgentSessionLifetimeContext
  sessions: StructuredAgentSessionConversations
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Caller already holds session serialization. */
  open: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  deliveryActive: (sessionId: string) => boolean
  /** Retain status rows while a tab still lists the chat. */
  closeStatus: (sessionId: string, options: { listed: boolean }) => void
  childWorkOpen: (sessionId: string) => boolean
}
