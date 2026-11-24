// Who a bot's running turn acts for: whom its conversation acts for (recorded when it started), and any
// person the cloud stamped on a message the turn took, or another bot's request. Never the model's say-so.
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../shared/agent-session/requests/structured-agent-session-command-entry'
import { structuredAgentTurnAnchors } from '../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { ConnectorSource } from '../../shared/connectors/external-conversation-link'
import {
  distinctAskers,
  OWNER_ACTS_FOR,
  shareTypistAsker,
  type AutomationTriggeredBy,
  type BotRequestAsker
} from '../../shared/bots/bot-acts-for'

/** The conversation a request came in, as Orca Cloud names it. */
export type BotRequestConversation = { source: ConnectorSource; externalId: string }

/** Where the turn's message was asked: an issue key, owner/repo#N or Slack channel id, with a link
 *  to the message when the source gave one. */
export type BotWakingPlace = {
  source: ConnectorSource
  placeId: string
  url?: string
  /** The message itself as an action ref, from the cloud; a reaction goes on it. */
  messageRef?: string
}

/** What the running turn acts for. */
export type BotActingTurn = {
  /** The message this turn answers: the person's, or the bot request it was woken by. */
  rootItemId: string | null
  askers: BotRequestAsker[]
  /** Who asked this turn: its stamped people, or the owner for a message typed in Orca. Labels and
   *  answer routes read this; every check reads askers. */
  askedBy: BotRequestAsker[]
  /** The text of the person's message, for the record. */
  request: string | null
  /** A bot request the turn was woken by: a request it sends continues that request's chain. */
  actingOnRequestId: string | null
  /** Every bot request the turn took, the first being actingOnRequestId. */
  requestIds: string[]
  /** Where the message that opened the turn was asked; null for the owner's own or a bot request. */
  wokenAt: BotWakingPlace | null
  /** Who did the event behind the automation prompt that opened the turn, for the record only. */
  triggeredBy?: AutomationTriggeredBy
  /** The event this turn acts on, as the host recorded it: its automation prompt's, or the one the
   *  waking request carries. A request the turn sends carries it on, its text marked as content. */
  origin?: AutomationTriggeredBy
}

export type BotActingTurnLookups = {
  /** Whether a message is a bot request Orca admitted. */
  isBotRequest: (messageId: string) => boolean
  /** Whom an admitted bot request acts for, from Orca's record of it; null when unreadable. */
  botRequestActsFor: (messageId: string) => BotRequestActsFor | null
  /** Whom the conversation acts for, as Orca recorded it when the conversation started. */
  conversationActsFor: readonly BotRequestAsker[]
  /** The thread, issue or pull request an automation run's event happened on. */
  automationPlace?: () => BotWakingPlace | null
  /** The workspace of the conversation this session answers, from its link. */
  conversationWorkspaceId: string | null
}

/** The people Orca recorded on a bot request: whom the chain acts for, who asked at its start, and
 *  the event that started the chain when one did. */
export type BotRequestActsFor = {
  askers: BotRequestAsker[]
  askedBy?: BotRequestAsker[]
  origin?: AutomationTriggeredBy
}

const MAX_REQUEST_TEXT = 500

function isRootUserMessage(item: AgentJournalRenderItem): boolean {
  return (
    item.body.kind === 'message' &&
    item.body.role === 'user' &&
    isRootAgentJournalItem(item) &&
    !isStructuredAgentSessionCommandEntry(item.body)
  )
}

function textOf(body: AgentJournalItemBody): string | null {
  if (body.kind !== 'message') {
    return null
  }
  const text = body.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
  return text ? text.slice(0, MAX_REQUEST_TEXT) : null
}

type ItemReading =
  | { kind: 'asker'; asker: BotRequestAsker; wokenAt?: BotWakingPlace | null }
  /** The owner's own message or an automation's prompt: it acts for the conversation, except an
   *  automation's run (`run`), which acts for the owner in whichever chat it lands. */
  | {
      kind: 'conversation'
      wokenAt?: BotWakingPlace | null
      triggeredBy?: AutomationTriggeredBy
      run?: true
    }
  | { kind: 'request'; messageIds: string[] }
  | { kind: 'agent' }

/** The bot requests a message delivered, by their mail ids; none for any other message. */
export function botRequestIdsOf(
  body: AgentJournalItemBody,
  isBotRequest: (messageId: string) => boolean
): string[] {
  const mail = body.kind === 'message' ? body.from?.orchestration : undefined
  return mail?.message === 'mail-notice'
    ? mail.messages.map((message) => message.messageId).filter(isBotRequest)
    : []
}

function readItem(body: AgentJournalItemBody, lookups: BotActingTurnLookups): ItemReading {
  if (body.kind !== 'message') {
    return { kind: 'agent' }
  }
  if (body.from) {
    const messageIds = botRequestIdsOf(body, lookups.isBotRequest)
    return messageIds.length > 0 ? { kind: 'request', messageIds } : { kind: 'agent' }
  }
  if (body.asker) {
    return { kind: 'asker', ...stampedAsker(body.asker, lookups.conversationWorkspaceId) }
  }
  const teammate = shareTypistAsker(body.typedBy)
  if (teammate) {
    return { kind: 'asker', asker: teammate }
  }
  const wokenAt = body.memorySource ? (lookups.automationPlace?.() ?? null) : undefined
  // A person's connector message whose asker didn't parse is someone Orca can't name, never the owner;
  // an event no one asked through acts for its conversation, like an automation's prompt.
  if (body.origin === 'connector' && !body.memorySource) {
    return { kind: 'asker', asker: { kind: 'unknown' }, ...(wokenAt ? { wokenAt } : {}) }
  }
  return {
    kind: 'conversation',
    ...(wokenAt !== undefined ? { wokenAt } : {}),
    ...(body.memorySource && body.triggeredBy ? { triggeredBy: body.triggeredBy } : {}),
    // Only Orca writes a run's record on a message; no client can send one.
    ...(body.automationRun ? { run: true as const } : {})
  }
}

function stampedAsker(
  asker: NonNullable<Extract<AgentJournalItemBody, { kind: 'message' }>['asker']>,
  workspaceId: string | null
): { asker: BotRequestAsker; wokenAt: BotWakingPlace } {
  return {
    asker: {
      kind: 'person',
      source: asker.source,
      userId: asker.userId,
      ...(asker.name ? { name: asker.name } : {}),
      workspaceId,
      // Another Slack app is no person: never the owner, nor a member with their rights.
      role: asker.app ? null : asker.role,
      placeKind: asker.place.kind,
      ...(asker.viaAccount ? { viaAccount: asker.viaAccount } : {})
    },
    wokenAt: {
      source: asker.source,
      placeId: asker.place.id,
      ...(asker.url ? { url: asker.url } : {}),
      ...(asker.messageRef ? { messageRef: asker.messageRef } : {})
    }
  }
}

/**
 * Whom a conversation Orca has no record for acts for, read from its first message: the person the
 * cloud stamped, the people a bot request was for, the teammate whose share connection typed it, or
 * the owner for the owner's own message, an event no one asked through and an automation's prompt
 * (from automations made before Orca recorded who made them). Null before any message.
 */
export function firstMessageActsFor(
  items: readonly AgentJournalRenderItem[],
  lookups: {
    botRequestAskers: (messageId: string) => BotRequestAsker[] | null
    conversationWorkspaceId: string | null
  }
): BotRequestAsker[] | null {
  const first = items.find(isRootUserMessage)
  if (!first || first.body.kind !== 'message') {
    return null
  }
  const { body } = first
  if (body.from) {
    const mail = body.from.orchestration
    const requested =
      mail?.message === 'mail-notice'
        ? mail.messages.flatMap((message) => lookups.botRequestAskers(message.messageId) ?? [])
        : []
    return requested.length > 0 ? distinctAskers(requested) : [...OWNER_ACTS_FOR]
  }
  if (body.asker) {
    return [stampedAsker(body.asker, lookups.conversationWorkspaceId).asker]
  }
  const teammate = shareTypistAsker(body.typedBy)
  if (teammate) {
    return [teammate]
  }
  if (body.origin === 'connector' && !body.memorySource) {
    return [{ kind: 'unknown' }]
  }
  return [...OWNER_ACTS_FOR]
}

/** Each turn's messages, newest turn first: the one that opened it and those steered into it. A
 *  message still queued belongs to no turn yet. A host that keeps no turn rows gives each its own.
 *  The opener is the chat's own anchor: a turn names a sent message by the provider's id for it. */
function turnWindows(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  newestTurns: number | null
): AgentJournalRenderItem[][] {
  const messages = items.filter(isRootUserMessage)
  // Of a bounded read, only the turns from its newest `newestTurns` root turn records on.
  const records = items.flatMap((item, index) =>
    isRootAgentJournalItem(item) && readAgentJournalTurn(item.body) ? [index] : []
  )
  const floor = newestTurns === null ? 0 : (records.at(-newestTurns) ?? 0)
  const turns = items.filter(
    (item, index) => index >= floor && item.body.kind === 'turn' && isRootAgentJournalItem(item)
  )
  if (turns.length === 0) {
    return newestTurns === null ? messages.map((message) => [message]).toReversed() : []
  }
  const anchors = structuredAgentTurnAnchors(items, submissions)
  return turns
    .toReversed()
    .map((turn) => {
      const opener = anchors.get(turn.itemId)
      return messages.filter(
        (message) =>
          message.itemId === opener ||
          (message.turnScope?.kind === 'turn' && message.turnScope.turnItemId === turn.itemId)
      )
    })
    .filter((window) => window.length > 0)
}

/**
 * The latest turn's askers: whom the conversation acts for, and every person stamped on the messages it
 * took, so a mixed turn is held to the least trusted. A turn woken only by agent mail (a worker's report)
 * reads the turn before it; it never reads a live automation run.
 */
export function readBotActingTurn(
  items: readonly AgentJournalRenderItem[],
  lookups: BotActingTurnLookups,
  submissions: readonly AgentJournalSubmission[] = []
): BotActingTurn {
  return readBotActingTurnWithin(items, lookups, submissions, null)!
}

/** `readBotActingTurn` over a conversation's newest `newestTurns` root turn records and the rows that
 *  place them; null when none of those turns decides it, so the reader widens. Null turns: all. */
export function readBotActingTurnWithin(
  items: readonly AgentJournalRenderItem[],
  lookups: BotActingTurnLookups,
  submissions: readonly AgentJournalSubmission[],
  newestTurns: number | null
): BotActingTurn | null {
  for (const window of turnWindows(items, submissions, newestTurns)) {
    const readings = window.map((item) => ({ item, reading: readItem(item.body, lookups) }))
    const requestIds = readings.flatMap((entry) =>
      entry.reading.kind === 'request' ? entry.reading.messageIds : []
    )
    const first = readings.find((entry) => entry.reading.kind === 'request')
    if (first) {
      // The people each request was for, from Orca's records, never the sending bot's text; with the
      // conversation's and anyone stamped in the same turn, so a mixed turn is held to the least trusted.
      const records = requestIds.map((messageId) => lookups.botRequestActsFor(messageId))
      const origin = records.find((record) => record?.origin)?.origin
      const fromRequests = records.flatMap((record): BotRequestAsker[] =>
        record && record.askers.length > 0 ? record.askers : [{ kind: 'unknown' }]
      )
      const stamped = readings.flatMap((entry) =>
        entry.reading.kind === 'asker' ? [entry.reading.asker] : []
      )
      return {
        rootItemId: first.item.itemId,
        askers: distinctAskers([...lookups.conversationActsFor, ...fromRequests, ...stamped]),
        askedBy: distinctAskers(
          records.flatMap((record) => record?.askedBy ?? record?.askers ?? [{ kind: 'unknown' }])
        ),
        request: null,
        actingOnRequestId: requestIds[0] ?? null,
        requestIds,
        wokenAt: null,
        ...(origin ? { origin } : {})
      }
    }
    const openers = readings.flatMap((entry) =>
      entry.reading.kind === 'asker' || entry.reading.kind === 'conversation'
        ? [{ item: entry.item, reading: entry.reading }]
        : []
    )
    const opener = openers[0]
    if (opener) {
      const stamped = openers.flatMap((entry): BotRequestAsker[] =>
        entry.reading.kind === 'asker' ? [entry.reading.asker] : []
      )
      // An event's automation prompt acts for the automation's creator; the event itself is content.
      const [origin] = openers.flatMap((entry) =>
        entry.reading.kind === 'conversation' && entry.reading.triggeredBy
          ? [entry.reading.triggeredBy]
          : []
      )
      // An automation's run acts for the owner wherever it lands; an older run's prompt asks for whom its
      // conversation acts; an unstamped message is the owner's own.
      const ran = openers.some(
        (entry) => entry.reading.kind === 'conversation' && entry.reading.run
      )
      const askedBy = openers.flatMap((entry) =>
        entry.reading.kind === 'asker'
          ? [entry.reading.asker]
          : entry.reading.kind === 'conversation' && entry.reading.run
            ? OWNER_ACTS_FOR
            : entry.item.body.kind === 'message' && entry.item.body.memorySource
              ? lookups.conversationActsFor
              : OWNER_ACTS_FOR
      )
      return {
        rootItemId: opener.item.itemId,
        // Anyone stamped in the same turn still holds a mixed turn to the least trusted.
        askers: distinctAskers([
          ...(ran ? OWNER_ACTS_FOR : lookups.conversationActsFor),
          ...stamped
        ]),
        askedBy: distinctAskers(askedBy),
        request: textOf(opener.item.body),
        actingOnRequestId: null,
        requestIds: [],
        wokenAt: opener.reading.wokenAt ?? null,
        ...(opener.reading.kind === 'conversation' && opener.reading.triggeredBy
          ? { triggeredBy: opener.reading.triggeredBy }
          : {}),
        ...(origin ? { origin } : {})
      }
    }
  }
  if (newestTurns !== null) {
    return null
  }
  // No message has opened a turn: the turn acts for the conversation.
  return {
    rootItemId: null,
    askers: distinctAskers(lookups.conversationActsFor),
    askedBy: distinctAskers(lookups.conversationActsFor),
    request: null,
    actingOnRequestId: null,
    requestIds: [],
    wokenAt: null
  }
}
