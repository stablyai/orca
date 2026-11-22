// The auto-close rule against the runtime: a chat's facts from the same tree its rows read, its items,
// waits, failed turn and unread mail; closing writes why before the tab goes; reopening shows the tab.
import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Bot } from '../../shared/bot-types'
import type { Automation } from '../../shared/automations/automation-definition'
import type { BotChatCloseFacts, BotChatItemFacts } from '../../shared/bots/bot-chat-auto-close'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readSharedBotChatTree, runtimeBotChatTreeIndex } from './bot-chat-tree-host'
import { chatHoldsAgentMail } from './bot-chat-mail-hold'
import { closeBotSession } from './bot-chat-session'
import { BotChatAutoClose } from './bot-chat-auto-close'
import {
  BotChatAutoCloseMarks,
  botChatAutoCloseMarksFile,
  botChatAutoCloseMarksFileIo
} from './bot-chat-auto-close-marks'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export const BOT_CHAT_AUTO_CLOSED_LINE =
  'Orca closed this chat because all its items are done or canceled. History is kept. Reopen it from the sidebar.'

/** Long enough after a start for chat records and statuses to load. */
export const BOT_CHAT_AUTO_CLOSE_BOOT_DELAY_MS = 15_000

const NO_ITEMS: BotChatItemFacts = { total: 0, open: 0, lastClosedAt: null }

function botOf(runtime: OrcaRuntimeService, botId: string): Bot | null {
  return runtime.bots.list().find((bot) => bot.id === botId) ?? null
}

function unreadMail(runtime: OrcaRuntimeService, sessionIds: readonly string[]): number {
  const db = runtime.getOrchestrationDb()
  return [...new Set(sessionIds)]
    .filter(isOrcaSessionId)
    .reduce((count, id) => count + db.getUnreadMessages(formatOrcaSessionAddress(id)).length, 0)
}

/** The chat's facts, or null when the bot or chat is gone. */
async function readChatCloseFacts(
  runtime: OrcaRuntimeService,
  automations: () => readonly Automation[],
  botId: string,
  chatId: string
): Promise<{ facts: BotChatCloseFacts; liveSessionId: string } | null> {
  const bot = botOf(runtime, botId)
  if (!bot) {
    return null
  }
  const [tree, items] = await Promise.all([
    readSharedBotChatTree(runtime, { botId }),
    runtime.botItems.store().chatItemFacts(botId)
  ])
  const chat = tree.chats.find((entry) => entry.chatId === chatId)
  if (!chat) {
    return null
  }
  const liveSessionId = chat.liveSessionId ?? chatId
  const rootOf = (id: string) => runtime.botItems.chatRootOf(id)
  const waits = automations().filter(
    (automation) =>
      automation.enabled &&
      automation.bot?.botId === botId &&
      automation.bot.chat &&
      rootOf(automation.bot.chat.sessionId) === chatId
  ).length
  const facts: BotChatCloseFacts = {
    chat,
    room: isBotGroupMemberSession(chatId),
    items: items[chatId] ?? NO_ITEMS,
    waits,
    failedTurn: chat.closed ? false : await chatHoldsAgentMail(runtime, liveSessionId),
    queuedMail: unreadMail(runtime, [chatId, liveSessionId])
  }
  return { facts, liveSessionId }
}

/** The close line, written before the tab goes: a status line, never a turn or mail to the agent. */
async function writeClosedLine(sessionId: string): Promise<void> {
  const host = getStructuredAgentSessionHost()
  const destination = await host?.captureAgentStartDestination(sessionId)
  if (host && destination) {
    await host.appendAgentStart(
      destination,
      {
        body: { kind: 'status', text: BOT_CHAT_AUTO_CLOSED_LINE },
        messageId: `auto-close:${randomUUID()}`
      },
      Date.now()
    )
  }
}

export function runtimeBotChatAutoClose(
  runtime: OrcaRuntimeService,
  automations: () => readonly Automation[]
): BotChatAutoClose {
  const marks = new BotChatAutoCloseMarks(
    botChatAutoCloseMarksFileIo(() => botChatAutoCloseMarksFile(getProfileUserDataPath()))
  )
  const liveOf = async (botId: string, chatId: string): Promise<string> =>
    (await readChatCloseFacts(runtime, automations, botId, chatId))?.liveSessionId ?? chatId
  // Handles are ids, so the rule holds no Node timer type.
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let nextTimer = 0
  return new BotChatAutoClose({
    now: () => Date.now(),
    setTimer: (run, ms) => {
      const id = nextTimer++
      const timer = setTimeout(() => {
        timers.delete(id)
        run()
      }, ms)
      timer.unref?.()
      timers.set(id, timer)
      return id
    },
    clearTimer: (handle) => {
      if (typeof handle !== 'number') {
        return
      }
      clearTimeout(timers.get(handle))
      timers.delete(handle)
    },
    facts: async (botId, chatId) =>
      (
        await readChatCloseFacts(runtime, automations, botId, chatId).catch((error: unknown) => {
          console.warn('[bots] could not read a chat for auto-close', error)
          return null
        })
      )?.facts ?? null,
    chatsWithItems: async (botId) =>
      Object.keys(await runtime.botItems.store().chatItemFacts(botId)),
    botIds: () => runtime.bots.list().map((bot) => bot.id),
    close: async (botId, chatId, by) => {
      const sessionId = await liveOf(botId, chatId)
      if (by === 'orca') {
        await writeClosedLine(sessionId).catch((error: unknown) =>
          console.warn('[bots] could not write the auto-close line', error)
        )
      }
      await closeBotSession(runtime, sessionId)
    },
    reopen: async (botId, chatId) => {
      const bot = botOf(runtime, botId)
      if (!bot) {
        return
      }
      await runtime.publishStructuredAgentSessionTab({
        workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
        sessionId: await liveOf(botId, chatId),
        agent: bot.agent,
        activate: false
      })
    },
    marks,
    changed: (botId) => runtime.notifyBotsChanged({ botIds: [botId], kinds: ['chats'] })
  })
}

/** The runtime's chat tree index and auto-close; once chats and statuses have loaded, every quiet
 *  chat starts its countdown from the full time. */
export function installBotChatRuntime(
  runtime: OrcaRuntimeService,
  automations: () => readonly Automation[]
): void {
  runtime.botChatTreeIndex = runtimeBotChatTreeIndex(runtime)
  const autoClose = runtimeBotChatAutoClose(runtime, automations)
  runtime.botChatAutoClose = autoClose
  setTimeout(() => void autoClose.boot(), BOT_CHAT_AUTO_CLOSE_BOOT_DELAY_MS).unref?.()
}
