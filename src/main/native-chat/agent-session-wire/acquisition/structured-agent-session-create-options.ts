import type { StructuredAgentSessionFirstMessage } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { reserveRequestFor } from './structured-agent-session-attach'

export type StructuredAgentSessionCreateOptions = {
  /** Plugin handoff re-approval, checked after preparation and before durable ownership. */
  beforeEffect?: () => void
  firstMessage?: StructuredAgentSessionFirstMessage
  /** In-process callers may reject background work after preparation without taking its slot;
   *  awaited right before the opening message, and a throw sends nothing. */
  beforeFirstMessage?: () => void | Promise<void>
  /** Asked synchronously after the last await, right before the new chat is registered and its
   *  delivery woken; false withdraws the opening message, which then never reaches the agent. */
  beforeDelivery?: () => boolean
  hostLaunchDirectory?: string
  catalogModels?: Parameters<typeof reserveRequestFor>[0]['models']
  /** Publish after durable creation, before agent delivery starts. */
  publishTab?: () => Promise<void>
}
