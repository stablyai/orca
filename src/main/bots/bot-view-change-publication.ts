// What the runtime's bot views show, kept current: the Bots list's order and filter, and teammates'
// Home titles, which the chat records work out from the bots' share rows.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { publishBotSidebarViewChanges } from '../runtime/client/settings/runtime-workspace-view-change-events'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  conversationRecordReader,
  lineageLiveSession
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { ShareNamesChange } from './bot-share-name-changes'

type BotViewRuntime = Pick<
  OrcaRuntimeService,
  'bots' | 'botShareDevices' | 'notifyBotsChanged' | 'refreshStructuredConversationTabTitle'
>

export function publishBotViewChanges(
  store: Parameters<typeof publishBotSidebarViewChanges>[0],
  runtime: BotViewRuntime
): void {
  publishBotSidebarViewChanges(store, () => runtime.notifyBotsChanged({ kinds: ['bot'] }))
  runtime.bots.shareNames.listen((change) => retitleTeammateHomes(runtime, change))
}

/** A changed title reaches what holds it in memory: an open chat host's naming feed and open tabs
 *  (the chats-tree index keys on the titles itself), and the device rows' name for older builds.
 *  Nothing is written for the title itself, and a closed chat host is never opened for it. */
export function retitleTeammateHomes(
  runtime: Pick<BotViewRuntime, 'botShareDevices' | 'refreshStructuredConversationTabTitle'>,
  { bot, sessionIds }: ShareNamesChange
): void {
  const host = getStructuredAgentSessionHost()
  if (host) {
    const records = conversationRecordReader(host.deps.store)
    for (const sessionId of sessionIds) {
      const live = lineageLiveSession(records, sessionId)?.sessionId ?? sessionId
      host.publishConversationName(live)
      runtime.refreshStructuredConversationTabTitle(folderWorkspaceKey(bot.folderWorkspaceId), live)
    }
  }
  void runtime.botShareDevices
    ?.syncBotShareDeviceNames()
    .catch((error: unknown) => console.warn('[bots] share device names not rewritten:', error))
}
