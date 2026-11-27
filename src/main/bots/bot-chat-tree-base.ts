// What a bot's chats tree is built from on its host, apart from live status, tabs and read state: the
// chats its records name and the Dispatches they started. The index keeps one per bot between reads;
// a full build from every record is the same function, and the index's oracle.
import { botChatPreviewText } from '../../shared/bots/bot-chat-preview-text'
import type { AgentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { defaultAgentChatLabel } from '../../shared/agent-session/conversation-naming/agent-session-chat-label'
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import type { BotChatOrigin, BotChatTreeChat } from '../../shared/bots/bot-chat-tree'
import { HOME_CHAT_TITLE } from '../../shared/bots/bot-chat-tree-model'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  isOrcaSessionId,
  type OrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { createCanonicalOrcaSessionResolver } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  resolveLineageRunningSession,
  type AgentSessionRecordReader,
  type LineageRunningSession
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import {
  addressableSessionParty,
  structuredSessionMailReachWith
} from '../runtime/orchestration/mailbox/routing/structured-session-mail-address'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  readSessionParties,
  type SessionPartyReader
} from '../runtime/orchestration/addressing/session-party-reader'
import { botChatRecordEmpty, botChatRecordRow } from '../runtime/rpc/methods/bots-chats'
import { automationRuns, type BotActivityHost } from './bot-activity-host'
import { isBotBackgroundRun, type BotBackgroundRuns } from './bot-background-run-records'
import { BotDispatchPlacement } from './bot-chat-dispatches'
import { terminalRunChatId } from './bot-chat-tree-rows'

// As the chat tabs name an unnamed chat; a host string, like the tab titles it stands beside.
const NEW_CHAT_TITLE = 'New chat'

/** What, besides its records, a bot's chats come from: its links, automations and their runs. */
export type BotChatInputs = {
  bot: Bot
  workspaceId: string
  links: readonly ExternalConversationLink[]
  automationById: ReadonlyMap<string, Automation>
  runs: readonly AutomationRun[]
}

export function readBotChatInputs(
  host: Pick<BotActivityHost, 'externalConversations' | 'automations' | 'automationRuns'>,
  bot: Bot
): BotChatInputs {
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  const automations = host
    .automations()
    .filter((automation) => automation.workspaceId === workspaceId)
  return {
    bot,
    workspaceId,
    links: host.externalConversations(bot.folderWorkspaceId),
    automationById: new Map(automations.map((automation) => [automation.id, automation])),
    runs: automationRuns(host, automations)
  }
}

/** Everything in the inputs a base depends on: which sessions and panes are the bot's, and how each
 *  chat's origin names it. Live run state and seen marks are read fresh on every read. */
export function botChatInputsKey(inputs: BotChatInputs): string {
  const { bot } = inputs
  return JSON.stringify([
    bot.folderWorkspaceId,
    bot.chatSessionId,
    inputs.runs.map((run) => [
      run.id,
      run.automationId,
      run.chatSessionId ?? null,
      run.terminalPaneKey ?? null,
      inputs.automationById.get(run.automationId)?.name ?? null
    ]),
    inputs.links.map((link) => [
      link.sessionId,
      link.source,
      link.place ?? null,
      link.title ?? null
    ])
  ])
}

/** A chat as its records say it, before live status, tabs and read state. */
// `liveSessionId`: the lineage's live session, when a /clear moved the chat past its own.
export type BotChatBaseChat = Pick<
  BotChatTreeChat,
  'chatId' | 'origin' | 'originLabel' | 'lastActiveAt' | 'preview' | 'liveSessionId' | 'closed'
> & {
  home: boolean
  /** Its own name, else its origin's, else the provider's default; a tab's title wins over it. */
  title: string
  /** The pane whose status is this chat's: its lineage's live session. */
  paneKey: string
  /** A side chat nobody has written in yet; it lists only while its tab is open. */
  empty: boolean
}

export type BotChatBaseContext = { db: OrchestrationDb; backgroundRuns: BotBackgroundRuns }

/** A built base, with what it takes to change one chat or one Dispatch in place. */
export type BotChatBaseBuild = {
  inputsKey: string
  chats: Map<string, BotChatBaseChat>
  /** The session ids the chats were read from, each the latest of its lineage. */
  sessionOfChat: Map<string, string>
  placement: BotDispatchPlacement
  rootOf: (sessionId: string) => string
  homeRoot: string | null
  originBySessionId: ReadonlyMap<string, { origin: BotChatOrigin; label?: string; title?: string }>
}

type BotChatRecordRow = NonNullable<ReturnType<typeof botChatRecordRow>>
type BotChatBasePartial = Pick<BotChatBaseBuild, 'rootOf' | 'homeRoot' | 'originBySessionId'>

/** The row a record lists as, or null for none of the bot's (another home, cleared into a successor, a
 *  background run). */
function botChatBaseRow(
  ctx: BotChatBaseContext,
  bot: Pick<Bot, 'folderWorkspaceId'>,
  record: AgentSessionConversationView,
  build: BotChatBasePartial
): BotChatRecordRow | null {
  return botOfHomeWorkspace([bot], record.location.workspaceId) &&
    !isBotBackgroundRun(ctx.backgroundRuns, record)
    ? botChatRecordRow(record, build.rootOf, build.homeRoot)
    : null
}

/** The chat a record is, or null for none of the bot's. */
export function botChatBaseChat(
  ctx: BotChatBaseContext,
  store: AgentSessionRecordReader,
  bot: Pick<Bot, 'folderWorkspaceId'>,
  record: AgentSessionConversationView,
  build: BotChatBasePartial
): BotChatBaseChat | null {
  const row = botChatBaseRow(ctx, bot, record, build)
  return row
    ? botChatBaseChatOfRow(
        ctx.db,
        store,
        record,
        row,
        resolveLineageRunningSession(store, row.id),
        build
      )
    : null
}

function botChatBaseChatOfRow(
  parties: SessionPartyReader,
  store: AgentSessionRecordReader,
  record: AgentSessionConversationView,
  row: BotChatRecordRow,
  /** The chat's lineage walked once, for its live session and its end. */
  running: LineageRunningSession,
  build: BotChatBasePartial
): BotChatBaseChat {
  const live = running.kind === 'unverifiable' ? null : running.record
  // Only a chat that truly ended is closed: one on another host or behind an unverifiable /clear is not.
  const root = store.getRecord(row.id)
  const reach = {
    running: () => running,
    addressable: (id: OrcaSessionId) => Boolean(addressableSessionParty(id, parties))
  }
  const closed = root ? structuredSessionMailReachWith(reach, store, root).kind === 'ended' : false
  const origin = row.home ? { origin: 'home' as const } : build.originBySessionId.get(row.id)
  const preview = botChatPreviewText(row.lastSaid ?? row.lastAsked ?? '')
  return {
    chatId: row.id,
    home: row.home,
    title: row.home
      ? HOME_CHAT_TITLE
      : row.title ||
        origin?.title ||
        // An unnamed chat keeps the name its tab gave it once the tab closes.
        (root ? defaultAgentChatLabel(root.provider) : NEW_CHAT_TITLE),
    origin: origin?.origin ?? 'side',
    ...(origin && 'label' in origin && origin.label ? { originLabel: origin.label } : {}),
    lastActiveAt: row.lastActivityAt,
    ...(preview ? { preview } : {}),
    paneKey: structuredAgentSessionStatusPaneKey(live?.sessionId ?? row.id),
    ...(live && live.sessionId !== row.id ? { liveSessionId: live.sessionId } : {}),
    closed,
    empty: !origin && record.sessionId === row.id && botChatRecordEmpty(record)
  }
}

/** Builds a bot's base from the records in its home; the full build passes every record. */
export function buildBotChatBase(
  ctx: BotChatBaseContext,
  store: AgentSessionRecordReader | null,
  inputs: BotChatInputs,
  records: readonly AgentSessionConversationView[]
): BotChatBaseBuild {
  const root = store ? createCanonicalOrcaSessionResolver(store) : (id: string) => id
  const rootOf = (id: string): string => (isOrcaSessionId(id) ? root(id) : id)
  const homeRoot =
    inputs.bot.chatSessionId && isOrcaSessionId(inputs.bot.chatSessionId)
      ? root(inputs.bot.chatSessionId)
      : null
  const originBySessionId = new Map<
    string,
    { origin: BotChatOrigin; label?: string; title?: string }
  >()
  for (const run of inputs.runs) {
    const automation = inputs.automationById.get(run.automationId)
    if (run.chatSessionId && automation) {
      originBySessionId.set(rootOf(run.chatSessionId), {
        origin: 'automation',
        label: automation.name,
        title: automation.name
      })
    }
  }
  for (const link of inputs.links) {
    // Discord has no mark of its own; its threads show as side chats.
    const origin: BotChatOrigin = link.source === 'discord' ? 'side' : link.source
    originBySessionId.set(rootOf(link.sessionId), {
      origin,
      ...(link.place ? { label: link.place } : {}),
      ...(link.title ? { title: link.title } : {})
    })
  }
  const homeRecords = records.filter((record) =>
    botOfHomeWorkspace([inputs.bot], record.location.workspaceId)
  )
  const chats = new Map<string, BotChatBaseChat>()
  const sessionOfChat = new Map<string, string>()
  const partial = { rootOf, homeRoot, originBySessionId }
  if (store) {
    const rows = homeRecords.flatMap((record) => {
      const row = botChatBaseRow(ctx, inputs.bot, record, partial)
      return row ? [{ record, row, running: resolveLineageRunningSession(store, row.id) }] : []
    })
    // One party read for the chats whose end the base checks; another host's chat, or a lineage that
    // can't be verified, is judged without this host's rows.
    const parties = readSessionParties(
      ctx.db,
      rows.flatMap(({ row, running }) =>
        running.kind === 'here' && isOrcaSessionId(running.sessionId) ? [row.id] : []
      )
    )
    for (const { record, row, running } of rows) {
      const chat = botChatBaseChatOfRow(parties, store, record, row, running, partial)
      chats.set(chat.chatId, chat)
      sessionOfChat.set(chat.chatId, record.sessionId)
    }
  }
  const terminalChats = new Set(
    inputs.runs.flatMap((run) =>
      !run.chatSessionId && inputs.automationById.has(run.automationId)
        ? [terminalRunChatId(run.id)]
        : []
    )
  )
  const chatOfSession = (sessionId: string): string | null => {
    const id = rootOf(sessionId)
    return chats.has(id) || terminalChats.has(id) ? id : null
  }
  const sessionIds = [
    ...new Set([
      ...homeRecords.map((record) => record.sessionId),
      ...inputs.runs.flatMap((run) => (run.chatSessionId ? [run.chatSessionId] : [])),
      ...inputs.links.map((link) => link.sessionId)
    ])
  ]
  const sessionByPaneKey = new Map(
    sessionIds.map((sessionId) => [structuredAgentSessionStatusPaneKey(sessionId), sessionId])
  )
  // A terminal run's workers go under its own row.
  const runByPaneKey = new Map(
    inputs.runs.flatMap((run) =>
      run.terminalPaneKey && !run.chatSessionId
        ? [[run.terminalPaneKey, terminalRunChatId(run.id)] as const]
        : []
    )
  )
  const chatOfPaneKey = (paneKey: string): string | null => {
    const sessionId = sessionByPaneKey.get(paneKey)
    const runChat = runByPaneKey.get(paneKey)
    return sessionId
      ? chatOfSession(sessionId)
      : runChat && terminalChats.has(runChat)
        ? runChat
        : null
  }
  const placement = new BotDispatchPlacement(chatOfSession, chatOfPaneKey, {
    orcaSessionIds: sessionIds,
    paneKeys: [
      ...sessionByPaneKey.keys(),
      ...inputs.runs.flatMap((run) => (run.terminalPaneKey ? [run.terminalPaneKey] : []))
    ]
  }).walk(ctx.db)
  return {
    inputsKey: botChatInputsKey(inputs),
    chats,
    sessionOfChat,
    placement,
    rootOf,
    homeRoot,
    originBySessionId
  }
}

/** Newest first; the id breaks ties, so a full build and the index list chats alike. */
export function orderedBaseChats(chats: Iterable<BotChatBaseChat>): BotChatBaseChat[] {
  return [...chats].sort(
    (a, b) =>
      b.lastActiveAt - a.lastActiveAt || (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0)
  )
}

/** A base as the oracle compares it: chats and Dispatches in one order, whatever order they were found. */
export function comparableBotChatBase(build: BotChatBaseBuild): string {
  return JSON.stringify({
    chats: orderedBaseChats(build.chats.values()),
    dispatches: build.placement.dispatches().toSorted((a, b) => (a.id < b.id ? -1 : 1))
  })
}
