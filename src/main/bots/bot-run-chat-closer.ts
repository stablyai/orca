// Closes the chats a bot's automation runs opened once each run ended and nothing waits on it, when
// the bot's `closeEndedRuns` is on: when it turns on, 10 minutes after each run, and once after a start.
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
import { runtimeRunChatClose, type ClosedRunChat } from './bot-run-chat-close-step'
import { chatRunId, coordinatesLiveRun, ownsOpenItem, personSpoke } from './bot-run-chat-facts'
import { botOfSession } from './bot-session-tabs'

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
    'tab-open': host.getSessionTabId(sessionId) !== null,
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

/** The bot's open chats, and the verdict on each a run opened (all, or just `only`). */
async function readRunChats(
  runtime: OrcaRuntimeService,
  bot: Bot,
  only?: string
): Promise<{ context: Context; open: BotChatRow[]; runChats: RunChatRead[] }> {
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
  for (const row of rows) {
    const items = owned.items
      .filter((item) => item.chatId === row.id)
      .map((item) => ({ number: item.number, status: item.status }))
    // One unreadable chat stays open; the rest are still judged.
    const read = await readRunChat(context, row, items).catch((error: unknown) => {
      console.warn('[bots] could not read a run chat', error)
      return null
    })
    if (read) {
      runChats.push(read)
    }
  }
  return { context, open, runChats }
}

/** `orca bot run-chats`: what a check would close now; reads only. */
export async function previewRunChats(
  runtime: OrcaRuntimeService,
  bot: Bot
): Promise<BotRunChatsPreview> {
  const { open, runChats } = await readRunChats(runtime, bot)
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
    notRunChats: open.length - runChats.length,
    close: runChats.filter((chat) => chat.keep.length === 0).map(row),
    keep: runChats
      .filter((chat) => chat.keep.length > 0)
      .map((chat) => ({ ...row(chat), keep: chat.keep })),
    itemMailTo: home ? { chatId: home.id, title: home.title } : null
  }
}

/** A close whose moves to the Home Chat failed is finished here, before the open chats are judged. */
async function settleClosedRunChats(
  runtime: OrcaRuntimeService,
  bot: Bot,
  settle: ReturnType<typeof runtimeRunChatClose>['settle']
): Promise<void> {
  const closed: ClosedRunChat[] = (await readBotChats(runtime, bot, null, true))
    .filter((row) => row.closed && row.reason === 'ended' && !row.home)
    .map((row) => ({ chatId: row.id, sessionId: liveSessionOf(row.id) }))
  const host = await requireStructuredHost(runtime)
  await settle(bot.id, closed, async (chatId) => (await chatRunId(host, chatId)) !== null)
}

export type RunChatCloseResult = {
  closed: number
  failed: number
  kept: Partial<Record<RunChatKeepReason, number>>
}

const closing = new Set<string>()

/** Closes the bot's ended run chats (all, or just `only`) when its setting is on; each is judged
 *  again under the bot's lock, so mail that came meanwhile keeps it. */
export async function closeEndedRunChats(
  runtime: OrcaRuntimeService,
  bot: Bot,
  only?: string
): Promise<RunChatCloseResult | null> {
  if (bot.closeEndedRuns !== true || closing.has(bot.id)) {
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
      } else if (outcome === 'failed') {
        failed += 1
      }
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
  }
}

function checkRunChats(runtime: OrcaRuntimeService, bot: Bot): void {
  void closeEndedRunChats(runtime, bot).catch((error: unknown) =>
    console.warn('[bots] run chat check failed', error)
  )
}

const closingBots = (runtime: OrcaRuntimeService) =>
  runtime.bots.list().filter((bot) => bot.closeEndedRuns === true)

/** After a take-and-new run ended, once its chat has been quiet long enough: a look at all the
 *  bot's run chats, so one an earlier look kept (its tab was open, mail unread) is judged again. */
export function scheduleRunChatCheck(runtime: OrcaRuntimeService, sessionId: string): void {
  const timer = setTimeout(() => {
    const bot = botOfSession(runtime.bots, sessionId)
    if (bot?.closeEndedRuns === true) {
      checkRunChats(runtime, bot)
    }
  }, RUN_CHAT_QUIET_MS + 30_000)
  timer.unref?.()
}

/** No timer runs while nothing happens: a bot's run chats are looked at when its setting turns on
 *  (closing what piled up), after each of its runs (above), and once a quiet window after start,
 *  for the looks a restart dropped. */
export function bindRunChatChecks(runtime: OrcaRuntimeService): () => void {
  let on = new Set(closingBots(runtime).map((bot) => bot.id))
  const stopListening = runtime.onBotsWritten(() => {
    const now = closingBots(runtime)
    now.filter((bot) => !on.has(bot.id)).forEach((bot) => checkRunChats(runtime, bot))
    on = new Set(now.map((bot) => bot.id))
  })
  const afterStart = setTimeout(
    () => closingBots(runtime).forEach((bot) => checkRunChats(runtime, bot)),
    RUN_CHAT_QUIET_MS
  )
  afterStart.unref?.()
  return () => {
    stopListening()
    clearTimeout(afterStart)
  }
}
