// Closes the chats a bot's automation runs opened once each run ended and nothing waits on it, when
// the bot's `closeEndedRuns` is on; bot-run-chat-checks says when it looks.
import type { Bot } from '../../shared/bot-types'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { BOT_ITEM_STATUSES } from '../../shared/bots/bot-items'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import type { AutomationRunStatus } from '../../shared/automations/history/automation-run'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import {
  RUN_CHAT_KEEP_REASONS,
  RUN_CHAT_QUIET_MS,
  runChatKeeps,
  runChatRunEnded,
  type BotRunChatPreviewRow,
  type BotRunChatsPreview,
  type RunChatFacts,
  type RunChatKeepReason
} from '../../shared/bots/bot-run-chat-close'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { readBotChats } from '../runtime/rpc/methods/bots-chats'
import { chatIsIdle, chatPaneKey } from '../external-conversations/external-conversation-chat'
import { requireStructuredHost } from './bot-chat-session'
import { runChatClosesOwed, runtimeRunChatClose } from './bot-run-chat-close-step'
import {
  chatRunId,
  coordinatesLiveRun,
  ownsOpenItem,
  personSpoke,
  runChatTabInFront
} from './bot-run-chat-facts'

type RunChatRead = BotRunChatPreviewRow & {
  /** The session running it now; a /clear moves it on from the row's root. */
  sessionId: string
  keep: RunChatKeepReason[]
}

type Context = {
  runtime: OrcaRuntimeService
  bot: Bot
  host: StructuredAgentSessionHost
  db: OrchestrationDb
  runStatus: Map<string, AutomationRunStatus>
  targeted: Set<string>
}

async function readContext(runtime: OrcaRuntimeService, bot: Bot): Promise<Context> {
  const automations = runtime.requireStore().listAutomations?.() ?? []
  return {
    runtime,
    bot,
    host: await requireStructuredHost(runtime),
    db: runtime.getOrchestrationDb(),
    runStatus: new Map(runtime.listAutomationRuns().map((run) => [run.id, run.status])),
    targeted: new Set(
      automations.flatMap((automation) =>
        automation.bot?.botId === bot.id && automation.bot.chat?.sessionId
          ? [automation.bot.chat.sessionId]
          : []
      )
    )
  }
}

/** The sessions a chat ran in, from the row's root, and the one running it now: a /clear moves it on.
 *  A chain that cannot be proved names the root as live, as mail to it does. */
function chatSessionsOf(chatId: string): {
  live: string
  all: readonly string[]
} {
  const store = readAgentSessionRecordStore()
  const running = store ? resolveLineageRunningSession(store, chatId) : null
  if (!running) {
    return { live: chatId, all: [chatId] }
  }
  return {
    live: running.kind === 'unverifiable' ? chatId : running.sessionId,
    all: running.lineage
  }
}

function liveSessionOf(chatId: string): string {
  return chatSessionsOf(chatId).live
}

/** One open chat's verdict; null when no run opened it. */
async function readRunChat(
  context: Context,
  row: BotChatRow,
  items: BotRunChatPreviewRow['items'],
  now = Date.now()
): Promise<RunChatRead | null> {
  const { host, db } = context
  const runId = await chatRunId(host, row.id)
  if (runId === null) {
    return null
  }
  const sessions = chatSessionsOf(row.id)
  const sessionId = sessions.live
  const facts: RunChatFacts = {
    'run-not-ended': !runChatRunEnded(context.runStatus.get(runId)),
    recent: now - row.lastActivityAt < RUN_CHAT_QUIET_MS,
    working: !chatIsIdle(host, sessionId),
    'unread-mail':
      isOrcaSessionId(sessionId) &&
      db.getUnreadMessages(formatOrcaSessionAddress(sessionId)).length > 0,
    'open-item': await ownsOpenItem(context.runtime, context.bot.id, row.id),
    'automation-target': context.targeted.has(row.id) || context.targeted.has(sessionId),
    thread: Boolean(
      context.runtime.getExternalConversationSeam()?.replyTarget(chatPaneKey(sessionId))?.key
    ),
    'live-run': coordinatesLiveRun(db, sessionId),
    'tab-in-front': runChatTabInFront(context.runtime, host, sessionId),
    'person-spoke': await personSpoke(host, sessions.all)
  }
  return {
    chatId: row.id,
    sessionId,
    title: row.title,
    lastActivityAt: row.lastActivityAt,
    items,
    keep: runChatKeeps(facts)
  }
}

type RunChatsRead = {
  open: BotChatRow[]
  runChats: RunChatRead[]
  /** Chats whose read failed: neither judged nor counted as no run's. */
  unreadable: number
  itemsCut: boolean
}

/** The bot's open chats, and the verdict on each a run opened (all, or just `only`). */
async function readRunChats(
  runtime: OrcaRuntimeService,
  bot: Bot,
  only?: string
): Promise<RunChatsRead> {
  const context = await readContext(runtime, bot)
  const open = await readBotChats(runtime, bot, null)
  const rows = open.filter(
    (row) =>
      !row.home &&
      row.id !== bot.chatSessionId &&
      !isBotGroupMemberSession(row.id) &&
      (only === undefined || row.id === only)
  )
  // What the preview lists; whether a chat owns an open item is counted per chat.
  const owned = await runtime.botItems.store().list({
    botId: bot.id,
    statuses: BOT_ITEM_STATUSES,
    chatIds: rows.map((row) => row.id),
    limit: 1000
  })
  const runChats: RunChatRead[] = []
  let unreadable = 0
  for (const row of rows) {
    const items = owned.items
      .filter((item) => item.chatId === row.id)
      .map((item) => ({ number: item.number, status: item.status }))
    // One unreadable chat stays open; the rest are still judged.
    const read = await readRunChat(context, row, items).catch((error: unknown) => {
      console.warn('[bots] could not read a run chat', error)
      unreadable += 1
      return null
    })
    if (read) {
      runChats.push(read)
    }
  }
  const listed = Object.values(owned.counts).reduce((sum, count) => sum + (count ?? 0), 0)
  return { open, runChats, unreadable, itemsCut: listed > owned.items.length }
}

/** `orca bot run-chats`: what a check would close now; reads only. */
export async function previewRunChats(
  runtime: OrcaRuntimeService,
  bot: Bot
): Promise<BotRunChatsPreview> {
  const { open, runChats, unreadable, itemsCut } = await readRunChats(runtime, bot)
  const row = ({ chatId, title, lastActivityAt, items }: RunChatRead): BotRunChatPreviewRow => ({
    chatId,
    title,
    lastActivityAt,
    items
  })
  const home = open.find((chat) => chat.home)
  return {
    bot: bot.name,
    on: bot.closeEndedRuns === true,
    open: open.length,
    notRunChats: open.length - runChats.length - unreadable,
    unreadable,
    close: runChats.filter((chat) => chat.keep.length === 0).map(row),
    keep: runChats
      .filter((chat) => chat.keep.length > 0)
      .map((chat) => ({ ...row(chat), keep: chat.keep })),
    itemMailTo: home ? { chatId: home.id, title: home.title } : null,
    itemsCut
  }
}

/** A close whose moves to the Home Chat failed is finished here, before the open chats are judged,
 *  setting on or off: the chat was closed while it was on. */
async function settleClosedRunChats(
  runtime: OrcaRuntimeService,
  bot: Bot,
  settle: ReturnType<typeof runtimeRunChatClose>['settle']
): Promise<void> {
  if (!runChatClosesOwed(runtime, bot.id)) {
    return
  }
  const rows = (await readBotChats(runtime, bot, null, true)).filter((row) => !row.home)
  const sessions = (closed: boolean) =>
    new Set(rows.filter((row) => row.closed === closed).map((row) => liveSessionOf(row.id)))
  await settle(bot.id, { closed: sessions(true), open: sessions(false) })
}

export type RunChatCloseResult = {
  closed: number
  failed: number
  kept: Partial<Record<RunChatKeepReason, number>>
}

const closing = new Set<string>()
/** Bots a look came for while one ran: each is looked at again once that ends, since the running
 *  look read its chats before whatever brought the new one. */
const lookAgain = new Set<string>()

/** Closes the bot's ended run chats (all, or just `only`) when its setting is on; each is judged
 *  again under the bot's lock, so mail that came meanwhile keeps it. */
export async function closeEndedRunChats(
  runtime: OrcaRuntimeService,
  bot: Bot,
  only?: string
): Promise<RunChatCloseResult | null> {
  if (closing.has(bot.id)) {
    lookAgain.add(bot.id)
    return null
  }
  closing.add(bot.id)
  try {
    // A closed host would skip the close, leaving the chat taking mail.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    const closer = runtimeRunChatClose(runtime)
    await settleClosedRunChats(runtime, bot, closer.settle).catch((error: unknown) =>
      console.warn('[bots] could not move what a closed run chat left', error)
    )
    if (bot.closeEndedRuns !== true) {
      return null
    }
    const { runChats } = await readRunChats(runtime, bot, only)
    const kept: RunChatCloseResult['kept'] = {}
    const keep = (reasons: readonly RunChatKeepReason[]) =>
      reasons.forEach((reason) => (kept[reason] = (kept[reason] ?? 0) + 1))
    const tried: string[] = []
    let failed = 0
    for (const chat of runChats) {
      if (chat.keep.length > 0) {
        keep(chat.keep)
        continue
      }
      const outcome = await closer
        .close(bot.id, chat.sessionId, async () => {
          const again = await readRunChats(runtime, bot, chat.chatId)
          // A /clear since the first read moved the chat on: the session now live is judged next look.
          const verdict = again.runChats.find((read) => read.sessionId === chat.sessionId)
          if (verdict) {
            keep(verdict.keep)
          }
          return verdict !== undefined && verdict.keep.length === 0
        })
        .catch((error: unknown) => {
          console.warn('[bots] could not close an ended run chat', error)
          return 'failed' as const
        })
      if (outcome === 'closed') {
        tried.push(chat.chatId)
      } else if (outcome === 'tab-in-front') {
        keep(['tab-in-front'])
      } else if (outcome === 'failed') {
        failed += 1
      }
      // 'stopping' counts nowhere yet: the chat closes once its agent's start ends.
    }
    // Counted by reading the chats again, not by the closes called.
    const stillOpen = new Set((await readBotChats(runtime, bot, null)).map((row) => row.id))
    const closed = tried.filter((id) => !stillOpen.has(id)).length
    failed += tried.length - closed
    if (closed > 0 || failed > 0) {
      const reasons = RUN_CHAT_KEEP_REASONS.filter((reason) => kept[reason])
        .map((reason) => `${reason} ${kept[reason]}`)
        .join(', ')
      console.info(
        `[bots] closed ${closed} ended run chat(s) of ${bot.name}; ${failed} failed to close; kept: ${reasons || 'none'}`
      )
    }
    return { closed, failed, kept }
  } finally {
    closing.delete(bot.id)
    const now = lookAgain.delete(bot.id) && runtime.bots.list().find((next) => next.id === bot.id)
    if (now) {
      void closeEndedRunChats(runtime, now).catch((error: unknown) =>
        console.warn('[bots] run chat check failed', error)
      )
    }
  }
}
