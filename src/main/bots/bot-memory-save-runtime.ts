// The memory-save watch as the runtime wires it: this host's ledger, its bot chats and its queue.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readAgentSessionRecordStore } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { structuredAgentSessionSendBlock } from '../native-chat/agent-session-wire/operations/structured-agent-session-send-preparation'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { botGroupRoomOfSession } from './bot-group-runtime'
import { botMemorySaveLedgerFile, createBotMemorySaveLedger } from './bot-memory-save-ledger'
import {
  BOT_MEMORY_SAVE_PROMPT,
  createBotMemorySaveWatch,
  type BotMemorySaveWatch
} from './bot-memory-save-watch'
import { isBotOwnChat } from './bot-own-chat'
import { botOfSession } from './bot-session-tabs'

export function runtimeBotMemorySaveWatch(runtime: OrcaRuntimeService): BotMemorySaveWatch {
  const host = async () => (await import('./bot-chat-session')).requireStructuredHost(runtime)
  return createBotMemorySaveWatch({
    ledger: createBotMemorySaveLedger(botMemorySaveLedgerFile(getCanonicalUserDataPath())),
    ownChatBot: (sessionId) => {
      const bot = botOfSession(runtime.bots, sessionId)
      const store = readAgentSessionRecordStore()
      const record = store?.getRecord(sessionId)
      return bot &&
        !bot.paused &&
        store &&
        record &&
        isBotOwnChat(record, runtime.getOrchestrationDb(), store) &&
        botGroupRoomOfSession(runtime, sessionId) === null &&
        runtime.lookAround.botOfLook(sessionId) === null &&
        runtime.lookAround.botOfTidyUp(sessionId) === null
        ? bot.id
        : null
    },
    contextUsage: async (sessionId) =>
      (await (await host()).journalReads(sessionId)).contextUsage(),
    idle: async (sessionId) => {
      const structured = await host()
      const work = await structured.currentWorkAtRest(sessionId)
      if (
        !work ||
        work.activeTurnId() !== null ||
        work.working() ||
        work.hasActionablePrompt() ||
        work.queueState().owedEnteredSubmissions.length > 0 ||
        structuredAgentSessionSendBlock(structured.deps.store.getRecord(sessionId))
      ) {
        return false
      }
      // A person or mail already waiting goes first; the save waits for the next idle turn end.
      const cards = await (await structured.conversation(sessionId)).journal.queuedMessages.list()
      return cards.every((card) => card.state !== 'waiting' && card.state !== 'returned')
    },
    send: async (botId, sessionId, memorySave) => {
      const { runtimeBotChats } = await import('./bot-chat-session')
      await runtimeBotChats(runtime).sendToSession(
        botId,
        sessionId,
        BOT_MEMORY_SAVE_PROMPT,
        undefined,
        { kind: 'memory-save', memorySave }
      )
    },
    warn: (message, error) => console.warn(message, error)
  })
}
