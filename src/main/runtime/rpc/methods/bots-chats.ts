// `bots.chats`: a bot's chats that mail can reach, newest first, so a bot can pick one by title and
// last ask and send it `--chat <id>`.
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatRow } from '../../../../shared/bots/bot-chat-row'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { BotRosterEntry } from '../../../../shared/bot-roster'
import { botOfHomeWorkspace } from '../../../../shared/bots/bot-homes'
import { BotChats, BotChatsSeen } from '../../../../shared/rpc-contract/bots-params'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../shared/agent-session/identity/orca-session-address'
import { createCanonicalOrcaSessionResolver } from '../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import {
  clearedInto,
  lineageLiveSession,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import {
  createStructuredSessionReachContext,
  type StructuredSessionReachContext
} from '../../orchestration/mailbox/routing/structured-session-mail-address'
import { refuseUndeliverableSessionRecipientWith } from './orchestration/messaging/session-recipient'
import { namedOrCallerBot } from './bots-caller-bot'
import { botShareChatFilter, botShareScopeOf } from '../../../bots/team-share/bot-share-chats'
import { defineMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  isBotBackgroundRun,
  type BotBackgroundRuns
} from '../../../bots/bot-background-run-records'

const BOT_CHATS_METHOD = defineMethod({
  name: 'bots.chats',
  permission: 'workspace',
  params: BotChats,
  handler: async (params, context) => {
    const { runtime } = context
    const { bot, caller } = namedOrCallerBot(params, context)
    const share = botShareScopeOf(context)
    if (share) {
      const owns = botShareChatFilter(runtime, share)
      const chats = await readBotChats(runtime, bot, null, params.all ?? false)
      return { bot: bot.name, chats: chats.filter((chat) => owns(chat.id)) }
    }
    // With the bot named, the claim only marks which row is the asking chat, so a paired client's counts.
    const asking = caller ?? (params.botId ? params.callerSessionId : undefined)
    return {
      bot: bot.name,
      chats: await readBotChats(runtime, bot, asking ?? null, params.all ?? false)
    }
  }
})

// Older clients need a successful empty count to clear their cached mailbox badge.
const BOT_CHATS_UNSEEN_METHOD = defineMethod({
  name: 'bots.chats.unseen',
  permission: 'workspace',
  params: null,
  handler: (): { unseen: Record<string, number> } => ({ unseen: {} })
})

/** A reveal marks a thread seen; a client that activates the chat's open tab itself says so here. */
const BOT_CHATS_SEEN_METHOD = defineMethod({
  name: 'bots.chats.seen',
  permission: 'workspace',
  params: BotChatsSeen,
  handler: (params, { runtime }) => {
    params.sessionIds.forEach((sessionId) => runtime.markBotThreadSeen(sessionId))
    return { ok: true as const }
  }
})

export const BOT_CHATS_METHODS = [BOT_CHATS_METHOD, BOT_CHATS_UNSEEN_METHOD, BOT_CHATS_SEEN_METHOD]

/** A bot's chats on this host; with `all`, its closed ones (earlier Home Chats) too. */
export async function readBotChats(
  runtime: Pick<
    OrcaRuntimeService,
    'ensureStructuredAgentSessionHost' | 'getOrchestrationDb' | 'lookAround'
  >,
  bot: Pick<Bot, 'folderWorkspaceId' | 'chatSessionId'>,
  callerSessionId: string | null,
  all = false
): Promise<BotChatRow[]> {
  // The records live in the chat host, which opens lazily.
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const rows = listBotChats(
    readAgentSessionRecordStore(),
    runtime.getOrchestrationDb(),
    bot,
    callerSessionId,
    runtime.lookAround
  )
  return all ? rows : rows.filter((row) => !row.closed)
}

/** One of a bot's chats that takes mail, by the id `orca bot chats` prints, with the session running
 *  it now (a /clear moves it on); null when the bot has no such chat or it was closed. */
export async function botChatTakingMail(
  runtime: Pick<
    OrcaRuntimeService,
    'ensureStructuredAgentSessionHost' | 'getOrchestrationDb' | 'lookAround'
  >,
  bot: Pick<Bot, 'folderWorkspaceId' | 'chatSessionId'>,
  id: string
): Promise<{ title: string | null; sessionId: string } | null> {
  const row = (await readBotChats(runtime, bot, null)).find((chat) => chat.id === id)
  if (!row) {
    return null
  }
  const store = readAgentSessionRecordStore()
  const live = store ? lineageLiveSession(store, row.id) : null
  return { title: row.title, sessionId: live?.sessionId ?? row.id }
}

/** `bot list`'s count of a bot's chats, naming the asking one when it is among them. */
export function botChatsSummary(
  chats: readonly BotChatRow[]
): NonNullable<BotRosterEntry['chats']> {
  const self = chats.find((chat) => chat.self)
  return {
    count: chats.length,
    home: chats.some((chat) => chat.home),
    ...(self ? { current: { home: self.home, title: self.title } } : {})
  }
}

/** No turn and no provider session: older chats with history predate `lastTurn` but have a session. */
export function botChatRecordEmpty(record: AgentSessionConversationView): boolean {
  return (
    !record.lastTurn &&
    record.providerHandleChain.length === 0 &&
    !record.conversationName &&
    !record.forkedFrom
  )
}

/** A record's row as the bot's chat list shows it, listed by its lineage's root; null for a record
 *  that is not an Orca chat or was cleared into a successor. Whether it takes mail is the caller's. */
export function botChatRecordRow(
  record: AgentSessionConversationView,
  rootOf: (id: string) => string,
  homeRoot: string | null
): Omit<BotChatRow, 'self' | 'closed'> | null {
  if (!isOrcaSessionId(record.sessionId) || clearedInto(record) !== null) {
    return null
  }
  const id = rootOf(record.sessionId)
  const turn = record.lastTurn
  return {
    id,
    title: record.conversationName ?? null,
    lastActivityAt: turn?.at ?? record.updatedAt,
    lastAsked: turn?.prompt ?? null,
    lastSaid: turn?.reply ?? null,
    home: id === homeRoot
  }
}

export function listBotChats(
  store: AgentSessionRecordReader | null,
  db: OrchestrationDb,
  bot: Pick<Bot, 'folderWorkspaceId' | 'chatSessionId'>,
  callerSessionId: string | null,
  /** Look around and Tidy-up run as conversations in the bot's home, but are never chats. */
  backgroundRuns: BotBackgroundRuns
): BotChatRow[] {
  if (!store) {
    return []
  }
  return listBotChatsWith(
    createStructuredSessionReachContext(store, db),
    store,
    bot,
    callerSessionId,
    backgroundRuns
  )
}

/** The rows of `bots.chats`, each lineage walked and each party resolved once through `context`, so a
 *  caller judging the same chats again in the same synchronous pass reuses that work. */
export function listBotChatsWith(
  context: StructuredSessionReachContext,
  store: AgentSessionRecordReader,
  bot: Pick<Bot, 'folderWorkspaceId' | 'chatSessionId'>,
  callerSessionId: string | null,
  backgroundRuns: BotBackgroundRuns
): BotChatRow[] {
  // A /clear keeps the conversation's address at its root, so each lineage is listed once, by that.
  const root = createCanonicalOrcaSessionResolver(store)
  const rootOf = (id: string | null) => (id && isOrcaSessionId(id) ? root(id) : null)
  const home = rootOf(bot.chatSessionId)
  const self = rootOf(callerSessionId)
  const rootOfChat = (id: string) => rootOf(id) ?? id
  return store
    .listRecords()
    .flatMap((record): BotChatRow[] => {
      const row =
        botOfHomeWorkspace([bot], record.location.workspaceId) &&
        !isBotBackgroundRun(backgroundRuns, record)
          ? botChatRecordRow(record, rootOfChat, home)
          : null
      if (!row || !isOrcaSessionId(record.sessionId)) {
        return []
      }
      const recipient = {
        sessionId: record.sessionId,
        address: formatOrcaSessionAddress(record.sessionId)
      }
      // The delivery check itself, so a picker lists exactly the chats mail would reach.
      const refusal = refuseUndeliverableSessionRecipientWith(context, recipient, store)
      return [
        {
          ...row,
          self: row.id === self,
          closed: refusal !== null,
          ...(refusal ? { reason: refusal.unreachable ?? 'unverifiable' } : {})
        }
      ]
    })
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}
