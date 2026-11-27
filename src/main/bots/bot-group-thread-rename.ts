import type { z } from 'zod'
import { botGroupRoom, type BotGroup, type BotGroupRenameThread } from '../../shared/bots/bot-group'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import type { BotGroupRuntime } from './bot-group-runtime'

/** A thread's own name, which its first post then keeps. Like that name, it is no roster change,
 *  so the revision stays and posts composed before it still send. */
export function renameBotGroupThread(
  groups: BotGroupRuntime,
  input: z.infer<typeof BotGroupRenameThread>
): Promise<BotGroup> {
  return runKeyedSerializedOperation(groups.queues, input.groupId, async () => {
    const previous = groups.store.get(input.groupId)
    // Refuses a thread that is no longer in the group.
    botGroupRoom(previous, input.threadId)
    const group: BotGroup = {
      ...previous,
      threads: previous.threads?.map((thread) =>
        thread.id === input.threadId ? { ...thread, title: input.title } : thread
      )
    }
    groups.store.put(group)
    groups.changed(input.groupId)
    return group
  })
}
