import type { z } from 'zod'
import type { BotGroup, BotGroupCreate } from '../../shared/bots/bot-group'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { createBotGroup } from './bot-group-membership'
import type { BotGroupRuntime } from './bot-group-runtime'

/** A new group; from a bot's offer card, the one already made from that card, however many
 *  windows or devices press Create group. */
export function createBotGroupOnce(
  groups: BotGroupRuntime,
  input: z.infer<typeof BotGroupCreate>
): Promise<BotGroup> {
  const offerId = input.fromOffer?.offerId
  if (!offerId) {
    return createBotGroup(groups, input)
  }
  return runKeyedSerializedOperation(groups.queues, `offer:${offerId}`, async () => {
    const made = groups.store.list().find((group) => group.fromOfferId === offerId)
    return made ?? createBotGroup(groups, input)
  })
}
