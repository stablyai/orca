import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { closeStructuredAgentSessionChild } from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import type { BotGroupRuntime } from './bot-group-runtime'
import { requireStructuredHost } from './bot-chat-session'

/** Gives each group saved before groups had homes its own home, and closes the spare bot session
 *  its room hung on. Runs once a runtime opens its database; a failure is retried next start. */
export async function migrateBotGroupHomes(groups: BotGroupRuntime): Promise<void> {
  const legacyGroups = groups.store.legacy()
  if (legacyGroups.length === 0) {
    return
  }
  // Startup runs before the native-chat host is installed; closing without it closes nothing.
  await requireStructuredHost(groups.runtime)
  for (const legacy of legacyGroups) {
    await runKeyedSerializedOperation(groups.queues, legacy.id, async () => {
      const agent =
        groups.runtime.bots.list().find((bot) => bot.id === legacy.members[0]?.botId)?.agent ??
        'claude'
      const { anchorSessionId, ...group } = legacy
      groups.store.put({
        ...group,
        ...(await groups.runtime.bots.createGroupHome(legacy.name, agent)),
        revision: legacy.revision + 1
      })
      await closeStructuredAgentSessionChild(anchorSessionId, { runtime: groups.runtime })
    })
  }
  groups.changed()
}
