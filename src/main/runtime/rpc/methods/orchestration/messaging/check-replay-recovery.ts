import type { DeliveryRow, OrchestrationDb } from '../../../../orchestration/db'
import { localOrchestrationCliCommand } from '../../../../orchestration/cli-command'
import {
  createOrchestrationReplayRecovery,
  type OrchestrationReplayRecovery
} from '../../../../../../shared/orchestration-check-output'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'

export type ReplayRecoveryMailbox = { runId: string; mailboxHandle: string }

export function checkReplayRecovery(args: {
  db: OrchestrationDb
  params: z.infer<typeof CheckParams>
  current: { delivery: DeliveryRow; replayed: boolean } | undefined
  additionalMailboxes?: ReplayRecoveryMailbox[] | (() => ReplayRecoveryMailbox[])
}): { replayRecovery?: OrchestrationReplayRecovery } {
  const { db, params, current } = args
  if (
    !current?.replayed ||
    !current.delivery.mailbox_handle ||
    params.peek ||
    params.all ||
    params.unread === false
  ) {
    return {}
  }
  let waitingCount: number | undefined
  try {
    if (db.getRun(current.delivery.run_id)?.legacy === 1) {
      return {}
    }
    const additionalMailboxes =
      typeof args.additionalMailboxes === 'function'
        ? args.additionalMailboxes()
        : args.additionalMailboxes
    const mailboxes: ReplayRecoveryMailbox[] = [
      { runId: current.delivery.run_id, mailboxHandle: current.delivery.mailbox_handle },
      ...(additionalMailboxes ?? [])
    ]
    waitingCount = mailboxes.reduce(
      (count, mailbox) =>
        count +
        db.countUnreadMessagesOutsideDelivery({
          ...mailbox,
          deliveryId: current.delivery.id
        }),
      0
    )
  } catch (error) {
    console.warn('[orchestration] Could not count mail waiting behind a replayed Delivery.', error)
  }
  return {
    replayRecovery: createOrchestrationReplayRecovery(
      current.delivery.id,
      {
        cliCommand: params.compatibilityCliCommand ?? localOrchestrationCliCommand(),
        terminal: params.terminal,
        run: params.run,
        consuming: true
      },
      waitingCount
    )
  }
}
