import type { OrchestrationDb } from '../../../../orchestration/db'
import { exposeMessages } from './mailbox-message-receipt'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'
import { checkReplayRecovery, type ReplayRecoveryMailbox } from './check-replay-recovery'

export function checkDeliveryResult(
  db: OrchestrationDb,
  params: z.infer<typeof CheckParams>,
  current: ReturnType<OrchestrationDb['getOrCreateMailboxDelivery']>,
  additionalMailboxes?: ReplayRecoveryMailbox[] | (() => ReplayRecoveryMailbox[])
) {
  return {
    deliveryId: current?.delivery.id ?? null,
    messages: exposeMessages(current?.messages ?? []),
    count: current?.messages.length ?? 0,
    replayed: current?.replayed ?? false,
    ...checkReplayRecovery({ db, params, current, additionalMailboxes })
  }
}
