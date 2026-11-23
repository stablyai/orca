/** Mail that reaches a bot from outside it: by `bot:<name|id>`, its session's address, or the Run its
 * chat coordinates. Orca resolves the receiving bot first, then reads who the sending turn is for from
 * its own record, never the model's. */

import type { Bot } from '../../../../../../shared/bot-types'
import { botOfAddress, parseBotAddress } from '../../../../../../shared/bot-roster'
import { isFinalAutomationRunStatus } from '../../../../../../shared/automations/history/automation-run'
import { isConnectorSource } from '../../../../../../shared/automation-event-triggers'
import { botOfSession } from '../../../../../bots/bot-session-tabs'
import { requireStructuredHost } from '../../../../../bots/bot-chat-session'
import { readBotConversationActsFor } from '../../../../../bots/bot-conversation-acts-for'
import {
  firstMessageActsFor,
  readBotActingTurn,
  type BotActingTurn,
  type BotRequestConversation,
  type BotWakingPlace
} from '../../../../../bots/bot-request-asker'
import { readNewestBotActingTurn } from '../../../../../bots/bot-acting-turn-read'
import type {
  AutomationTriggeredBy,
  BotRequestAsker
} from '../../../../../../shared/bots/bot-acts-for'
import { botRequestActsFor, botRequestRecord } from './bot-request-record'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  BOT_REQUEST_GROUP_WORKER_REFUSAL,
  botNotFound,
  type BotRequestRefusal
} from '../../../../../bots/bot-request-policy'
import { isBotGroupMemberSession } from '../../../../../../shared/bots/bot-group'
import { chatPaneKey } from '../../../../../external-conversations/external-conversation-chat'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { currentRunCoordinatorOrcaSessionId } from '../../../../orchestration/db/runs/run-coordinator-orca-session'
import { readAgentSessionRecordStore } from '../../../../orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { mayNameSession, readSessionRecipient } from './session-recipient'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import {
  isOrcaSessionId,
  type OrcaSessionId
} from '../../../../../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'

/** `chat` is the chat an address names; null when the bot is named, which reaches its Home Chat.
 *  `newChat`: sent with `--chat new`, so it lands in a chat the bot starts for it. */
export type ReceivingBot = {
  bot: Bot
  via: 'alias' | 'address'
  chat: OrcaSessionId | null
  newChat?: boolean
}

/** Whether mail to `receiving` lands in a chat other than the sending one: a new chat always does, and
 *  the bot's name lands in its Home Chat (made on first use). The /clear root names each chat. */
export function toOtherChat(receiving: ReceivingBot, senderSessionId: string | null): boolean {
  if (!senderSessionId || !isOrcaSessionId(senderSessionId)) {
    return false
  }
  if (receiving.newChat) {
    return true
  }
  const home = receiving.via === 'alias' ? receiving.bot.chatSessionId : null
  const chat = receiving.chat ?? home
  if (!chat || !isOrcaSessionId(chat)) {
    return receiving.via === 'alias'
  }
  return canonicalOrcaSessionId(chat) !== canonicalOrcaSessionId(senderSessionId)
}

export function refuse(refusal: BotRequestRefusal): never {
  throw new OrchestrationError(refusal.code, refusal.message)
}

type AddressReach =
  | { kind: 'none' }
  | { kind: 'bot'; receiving: ReceivingBot }
  | { kind: 'session' }

/** What an address may reach, decided without waiting: a bot by name (an unknown name is refused), a
 *  Run a bot's chat coordinates, or a session to look up. A Run's own workers mail it as ever. */
export function botAddressReach(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  to: string,
  sender: OrchestrationCallerIdentity,
  { fromPairedComputer = false }: { fromPairedComputer?: boolean } = {}
): AddressReach {
  const name = parseBotAddress(to)
  const bots = runtime.bots.list()
  if (name !== null) {
    const bot = botOfAddress(bots, name)
    // Mail another computer sent here with --on: it chose this computer, and our --on names mean nothing there.
    const paired = fromPairedComputer ? undefined : runtime.pairedBotRosters.lastRead()
    return bot
      ? { kind: 'bot', receiving: { bot, via: 'alias', chat: null } }
      : refuse(botNotFound(name, bots, paired))
  }
  if (bots.length === 0) {
    return { kind: 'none' }
  }
  if (to.startsWith('run:')) {
    const runId = to.slice('run:'.length)
    const member =
      db.getActiveDispatchForIdentity(sender.address, sender.paneKey ?? undefined)?.run_id === runId
    const run = member ? undefined : db.getRun(runId)
    const coordinator = run ? currentRunCoordinatorOrcaSessionId(run) : null
    const bot = coordinator ? botOfSession(runtime.bots, coordinator) : null
    const chat = coordinator && isOrcaSessionId(coordinator) ? coordinator : null
    return bot ? { kind: 'bot', receiving: { bot, via: 'address', chat } } : { kind: 'none' }
  }
  return mayNameSession(to) ? { kind: 'session' } : { kind: 'none' }
}

/** The bot an address reaches, or null when it reaches no bot. */
export async function receivingBot(
  runtime: OrcaRuntimeService,
  reach: AddressReach,
  to: string
): Promise<ReceivingBot | null> {
  if (reach.kind !== 'session') {
    return reach.kind === 'bot' ? reach.receiving : null
  }
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  // A bot is only ever a chat, so a terminal agent here reaches no bot.
  const session = readSessionRecipient(to, readAgentSessionRecordStore(), null)
  const sessionId = session && 'sessionId' in session ? session.sessionId : null
  const bot = sessionId ? botOfSession(runtime.bots, sessionId) : null
  return bot && sessionId ? { bot, via: 'address', chat: sessionId } : null
}

/** Who sends: the chat it acts from (a worker acts for the chat that started it), and that chat's bot. */
export type ActingSender = {
  sessionId: string | null
  bot: Bot | null
  turn: BotActingTurn
  conversation: BotRequestConversation | null
  /** What started the sending conversation when an automation did, for the record. */
  triggeredBy?: AutomationTriggeredBy | null
  /** A bot's worker's Dispatch: it acts for its conversation's record, not another asker's newer turn. */
  worker?: string
}

const OWNER_TURN: BotActingTurn = {
  rootItemId: null,
  askers: [{ kind: 'owner' }],
  askedBy: [{ kind: 'owner' }],
  request: null,
  actingOnRequestId: null,
  requestIds: [],
  wokenAt: null
}

// A worker can be started by another worker; the chat at the top of that line is who it acts for.
const MAX_CREATOR_HOPS = 8

export function creatorSession(
  db: OrchestrationDb,
  sender: OrchestrationCallerIdentity
): { sessionId: string | null; dispatchId: string | null; terminalCreated: boolean } {
  let dispatch = db.getActiveDispatchForIdentity(sender.address, sender.paneKey ?? undefined)
  if (!dispatch) {
    return { sessionId: null, dispatchId: null, terminalCreated: false }
  }
  const dispatchId = dispatch.id
  for (let hop = 0; hop < MAX_CREATOR_HOPS && dispatch.creator_dispatch_id; hop += 1) {
    const creator = db.getDispatchContextById(dispatch.creator_dispatch_id)
    if (!creator) {
      break
    }
    dispatch = creator
  }
  return {
    sessionId: dispatch.creator_orca_session_id,
    dispatchId,
    terminalCreated: dispatch.creator_orca_session_id === null && dispatch.creator_handle !== null
  }
}

/** The one automation run in progress in this chat, if exactly one is: where its event happened, never
 *  whom the chat acts for, which the conversation's own record says. */
function runningAutomationRun(runtime: OrcaRuntimeService, sessionId: string) {
  const running = runtime
    .listAutomationRuns()
    .filter((run) => run.chatSessionId === sessionId && !isFinalAutomationRunStatus(run.status))
  return running.length === 1 ? running[0] : undefined
}

/** The thread, issue or pull request a running automation run's event happened on. */
function automationPlace(runtime: OrcaRuntimeService, sessionId: string): BotWakingPlace | null {
  const run = runningAutomationRun(runtime, sessionId)
  const event = run?.trigger === 'event' ? run.event : undefined
  return event?.subject && isConnectorSource(event.source)
    ? { source: event.source, placeId: event.subject, ...(event.url ? { url: event.url } : {}) }
    : null
}

// Every source's conversation id starts with its workspace (the cloud's botConversationId).
function workspaceOf(externalId: string): string | null {
  return externalId.split(':')[0] || null
}

/** Who the sender acts for; null for a bot's own worker mailing its own chat, which is ordinary mail. */
export async function readActingSender(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  callerSessionId: string | undefined,
  sender: OrchestrationCallerIdentity,
  receiving: ReceivingBot
): Promise<ActingSender | null> {
  const creator = creatorSession(db, sender)
  if (creator.dispatchId) {
    const creatorBot = creator.sessionId ? botOfSession(runtime.bots, creator.sessionId) : null
    // Its own chat (or the Run it coordinates) is ordinary mail; the bot's other chats are other agents.
    if (
      creatorBot?.id === receiving.bot.id &&
      receiving.via === 'address' &&
      receiving.chat &&
      !toOtherChat(receiving, creator.sessionId)
    ) {
      return null
    }
    if (creatorBot && creator.sessionId) {
      if (isBotGroupMemberSession(creator.sessionId)) {
        return refuse(BOT_REQUEST_GROUP_WORKER_REFUSAL)
      }
      const read = await readBotTurn(runtime, db, creator.sessionId)
      return {
        sessionId: creator.sessionId,
        bot: creatorBot,
        turn: { ...OWNER_TURN, askers: read.actsFor, askedBy: read.actsFor },
        conversation: read.conversation,
        triggeredBy: read.triggeredBy,
        worker: creator.dispatchId
      }
    }
    // The owner's own orchestration; a worker whose starter Orca can't name is no one's.
    const known = creator.sessionId !== null || creator.terminalCreated
    return {
      sessionId: null,
      bot: null,
      turn: known
        ? OWNER_TURN
        : { ...OWNER_TURN, askers: [{ kind: 'unknown' }], askedBy: [{ kind: 'unknown' }] },
      conversation: null
    }
  }
  if (!callerSessionId) {
    return { sessionId: null, bot: null, turn: OWNER_TURN, conversation: null }
  }
  const bot = botOfSession(runtime.bots, callerSessionId)
  const read = await readBotTurn(runtime, db, callerSessionId)
  // The owner's own chat is the owner's; its turn still names the request, for dedupe and its chain.
  return bot
    ? {
        sessionId: callerSessionId,
        bot,
        turn: read.turn,
        conversation: read.conversation,
        triggeredBy: read.triggeredBy
      }
    : {
        sessionId: callerSessionId,
        bot: null,
        turn: { ...OWNER_TURN, rootItemId: read.turn.rootItemId },
        conversation: null
      }
}

/** What a bot's chat is doing now: who its running turn is for, and the conversation it answers.
 *  With `opening`, the turn that message is about to open, read from it alone, not the journal.
 *  `askersOnly` skips where an automation's run was woken, which its askers never depend on. */
export async function readBotTurn(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  sessionId: string,
  opening?: AgentJournalMessageItem,
  askersOnly = false
): Promise<{
  turn: BotActingTurn
  conversation: BotRequestConversation | null
  /** Whom the conversation acts for, and what started it when an automation did. */
  actsFor: BotRequestAsker[]
  triggeredBy: AutomationTriggeredBy | null
}> {
  const key = runtime.getExternalConversationSeam()?.replyTarget(chatPaneKey(sessionId))?.key
  const conversation = key ? { source: key.source, externalId: key.externalId } : null
  const workspaceId = conversation ? workspaceOf(conversation.externalId) : null
  const host = await requireStructuredHost(runtime)
  const root = isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
  let recorded = readBotConversationActsFor(runtime, root)
  if (!recorded) {
    // Conversations from before Orca recorded this, and ones a person opened: their first message
    // says, and is kept as the record. A cleared chat reads its root's.
    const firstPrompt = await (await host.journalReads(root)).promptItem('first')
    const first = firstMessageActsFor(firstPrompt ? [firstPrompt] : [], {
      botRequestAskers: (messageId) => botRequestRecord(db, messageId)?.askers ?? null,
      conversationWorkspaceId: workspaceId
    })
    if (first) {
      db.recordBotConversationActsFor(root, { actsFor: first })
      recorded = { actsFor: first }
    }
  }
  const actsFor = recorded?.actsFor ?? [{ kind: 'unknown' as const }]
  const lookups = {
    isBotRequest: (messageId: string) => db.getBotRequest(messageId) !== undefined,
    botRequestActsFor: (messageId: string) => botRequestActsFor(db, messageId),
    conversationActsFor: actsFor,
    ...(askersOnly ? {} : { automationPlace: () => automationPlace(runtime, sessionId) }),
    conversationWorkspaceId: workspaceId
  }
  const turn = opening
    ? readBotActingTurn([openingItem(opening)], lookups, [])
    : await readNewestBotActingTurn(await host.journalReads(sessionId), lookups)
  // The prompt that opened the turn names its event; a conversation an automation or request started keeps it.
  const triggeredBy = turn.triggeredBy ?? recorded?.triggeredBy ?? null
  return { turn, conversation, actsFor, triggeredBy }
}

/** A message not yet in the journal, as the one row of the turn it opens. */
function openingItem(body: AgentJournalMessageItem): AgentJournalRenderItem {
  return { itemId: 'opening', revision: 1, sequence: 0, observedAt: 0, body }
}
