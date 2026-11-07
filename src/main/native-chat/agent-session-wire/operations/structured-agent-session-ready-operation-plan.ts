import type { MutationPlan } from './structured-agent-session-mutation-plans'

export type ReadyOperationPlan<T> = Pick<
  MutationPlan<T>,
  'method' | 'fields' | 'operationIdScope' | 'commandReceipt'
> &
  Partial<
    Pick<MutationPlan<T>, 'replay' | 'rerunWhenReplayMissing' | 'recoverUnknownFromDurableState'>
  >
