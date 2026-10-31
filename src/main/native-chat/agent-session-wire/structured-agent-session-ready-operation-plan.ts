import type { AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import type { StructuredAgentSessionDeliveryPlace } from './structured-agent-session-delivery-order'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'
import type { MutationPlan } from './structured-agent-session-mutation-plans'

export type ReadyOperationPlan<T> = Pick<
  MutationPlan<T>,
  'method' | 'fields' | 'operationIdScope' | 'commandReceipt'
> &
  Partial<
    Pick<MutationPlan<T>, 'replay' | 'rerunWhenReplayMissing' | 'recoverUnknownFromDurableState'>
  >

export type QueuedReadyOperation<T> =
  | { result: AgentSessionMutationResult<T> }
  | {
      /** null starts a child outside serialization. */
      child: StructuredAgentSessionProviderChildIdentity | null
      readiness: StructuredAgentSessionStartReadiness | null
      start: StructuredAgentSessionStartClaim | null
      place: StructuredAgentSessionDeliveryPlace
    }
