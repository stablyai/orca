// A paused bot's own chats take no orchestration mail; resuming delivers what they held.
import type { Bot } from '../../shared/bot-types'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readAgentSessionRecordStore } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { BotController } from './bot-controller'
import { isBotOwnChat } from './bot-own-chat'
import { botOfSession } from './bot-session-tabs'

type BotMailRuntime = {
  bots: Pick<BotController, 'list'>
  getOrchestrationDb: () => OrchestrationDb
}

/** Whether `sessionId` is one of a paused bot's own chats: its mail waits unread until the bot is
 *  resumed. Workers running in the bot's home keep taking theirs. */
export function pausedBotChatHoldsMail(runtime: BotMailRuntime, sessionId: string): boolean {
  if (!botOfSession(runtime.bots, sessionId)?.paused) {
    return false
  }
  const store = readAgentSessionRecordStore()
  const record = store?.getRecord(sessionId)
  return Boolean(store && record && isBotOwnChat(record, runtime.getOrchestrationDb(), store))
}

/** On resume a bot's chats take the mail they held as after any busy period: each gets its idle
 *  edge's redrive, and its queue looks again at the cards it walked past. */
export function releaseHeldBotMail(
  runtime: BotMailRuntime & { redriveStructuredSessionMail: (sessionId: string) => void },
  bot: Pick<Bot, 'id'>
): void {
  const store = readAgentSessionRecordStore()
  if (!store) {
    return
  }
  const bots = runtime.bots.list()
  const db = runtime.getOrchestrationDb()
  for (const record of store.listRecords()) {
    if (
      botOfHomeWorkspace(bots, record.location.workspaceId)?.id === bot.id &&
      isBotOwnChat(record, db, store)
    ) {
      runtime.redriveStructuredSessionMail(record.sessionId)
      getStructuredAgentSessionHost()?.wakeQueuedMessages(record.sessionId)
    }
  }
}
