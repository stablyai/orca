// Posts the owner's Orca-typed messages into their bot chat's Slack thread, and holds the turn's
// reply until those posts settled, so Slack never shows an answer before its question.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  SlackMirrorDeleteBody,
  SlackMirrorStatus
} from '../../shared/connectors/connector-slack-mirror-contract'
import {
  conversationOpener,
  slackMirrorAvailable,
  slackMirrorDefault,
  slackMirrorMayPost,
  slackMirrorPosts,
  type SlackMirrorGate
} from '../../shared/connectors/slack-mirror-state'
import { slackMirrorPostsShare } from '../../shared/connectors/slack-mirror-share-posts'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  cloudConversation,
  type ConnectorAsker
} from '../../shared/connectors/connector-cloud-contract'
import type { AdmittedMessage } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { readLinks, type LinkedConversation } from './external-conversation-links'
import { postsWaiting, withHeldTurnEnd, type ConversationTurnEnd } from './slack-mirror-held'
import { SlackMirrorLinks, type SlackMirrorLinkDeps } from './slack-mirror-links'
import {
  mirroringCloud,
  postSlackMirrorMessage,
  readSlackMirrorStatus,
  slackMirrorCall,
  type SlackMirrorCall,
  type SlackMirrorCloud
} from './slack-mirror-cloud'

/** The send id behind a person's message item; null for any other item. */
function clientMessageIdOf(itemId: string): string | null {
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && 'clientMessageId' in identity
    ? identity.clientMessageId
    : null
}

export type SlackMirrorDeps = SlackMirrorLinkDeps & {
  cloud: () => SlackMirrorCloud | null
  /** The Orca account's name, posted beside the words. */
  orcaName: () => string
  /** A bot's "Post my Orca messages to Slack threads I start"; undefined reads as on. */
  botSetting: (botId: string) => boolean | undefined
  /** A message of the chat, read back for Retry. */
  readMessage: (sessionId: string, itemId: string) => Promise<AgentJournalMessageItem | null>
  /** Whom the chat acts for, as Orca recorded it; undefined when it has no record. */
  chatActsFor: (sessionId: string) => readonly BotRequestAsker[] | undefined
  signal: AbortSignal
  random?: () => number
}

/** A turn some of whose messages posted: its end goes once those posts settled. */
export type SlackMirrorTurn = { release: (event: ConversationTurnEnd) => void }

const STATUS_TTL_MS = 5 * 60_000

function isPersonsMessage(body: AgentJournalMessageItem): boolean {
  return body.role === 'user' && !body.from && !body.origin && !body.command
}

export class SlackMirror extends SlackMirrorLinks {
  private readonly turnPosts = new Map<string, Set<string>>()
  private readonly statusCache = new Map<string, { at: number; status: SlackMirrorStatus }>()

  constructor(protected override readonly deps: SlackMirrorDeps) {
    super(deps)
  }

  private enabled(): SlackMirrorCloud | null {
    return mirroringCloud(this.deps.cloud())
  }

  /** The gate a message posts through: a shared teammate's own message in their own chat posts as
   *  a default-on chat's (still waiting for Slack Connect) until the owner sets the chat; any
   *  other, as the chat is set. */
  private gateOf(
    link: ExternalConversationLink,
    sessionId: string,
    body: AgentJournalMessageItem
  ): SlackMirrorGate {
    const botId = link.bot?.botId
    const share =
      botId !== undefined &&
      link.mirrorChosen !== true &&
      slackMirrorPostsShare(
        body.typedBy,
        this.deps.chatActsFor(sessionId),
        this.deps.botSetting(botId)
      )
    return share
      ? { mirror: true, mirrorBlocked: link.mirrorBlocked, mirrorExternal: link.mirrorExternal }
      : link
  }

  private caller(cloud: SlackMirrorCloud, botId: string): SlackMirrorCall {
    return { cloud, botId, signal: this.deps.signal, random: this.deps.random ?? Math.random }
  }

  /** A thread's new chat records who began it, which sets whether it posts back. A link rebound to
   *  another chat (`fresh` false) keeps what it had: a chat from before this stays off. */
  opened(
    linked: LinkedConversation | null,
    asker: ConnectorAsker,
    fresh: boolean
  ): LinkedConversation | null {
    if (!linked || !fresh) {
      return linked
    }
    const { link, workspace } = linked
    if (link.opener || !link.bot || !slackMirrorAvailable(link)) {
      return linked
    }
    const opener = conversationOpener(asker)
    const mirror = slackMirrorDefault(opener, this.deps.botSetting(link.bot.botId))
    const next = { ...link, opener, mirror }
    return this.write(linked, next) ? { workspace, link: next } : linked
  }

  /** A message a chat admitted: the owner's own (or a shared teammate's in their own chat), in a
   *  chat that posts to its thread, posts there.
   *  Deliveries, mail and automation runs carry `origin` or `from`, so they never do; a delivery
   *  from the thread proves it open again. */
  admitted(message: AdmittedMessage): void {
    const workspace = { worktreeId: message.workspaceId, sshHostId: null }
    const link = readLinks(this.deps.store, workspace).find(
      (entry) => entry.sessionId === message.sessionId
    )
    if (!link || !slackMirrorAvailable(link)) {
      return
    }
    const linked = { workspace, link }
    if (message.body.origin === 'connector' && link.mirrorBlocked) {
      const { mirrorBlocked: _cleared, ...open } = link
      this.write(linked, open)
      return
    }
    if (
      !isPersonsMessage(message.body) ||
      !slackMirrorMayPost(this.gateOf(link, message.sessionId, message.body)) ||
      !this.enabled()
    ) {
      return
    }
    const itemId = agentJournalSubmissionKey(message.clientMessageId)
    const posts = this.turnPosts.get(message.sessionId) ?? new Set<string>()
    posts.add(itemId)
    this.turnPosts.set(message.sessionId, posts)
    // Recorded now, so a turn that ends before the post answers waits for it.
    this.record(linked, itemId, { state: 'posting', at: Date.now() })
    void this.postOnce(message.sessionId, itemId, message.clientMessageId, message.body)
  }

  /** Whether the thread saw the chat's running turn: one of its messages is posted or posting, not
   *  failed or dismissed. A restart ends the turn (its continuation is Orca's), so memory suffices. */
  turnPosted(sessionId: string): boolean {
    const posts = this.linkOfSession(sessionId)?.link.mirrorPosts ?? {}
    return [...(this.turnPosts.get(sessionId) ?? [])].some((itemId) => {
      const state = posts[itemId]?.state
      return state === 'posting' || state === 'posted'
    })
  }

  /** The chat's turn ended: null when none of its messages posted, so its reply stays in Orca. */
  turnEnded(sessionId: string): SlackMirrorTurn | null {
    const posts = [...(this.turnPosts.get(sessionId) ?? [])]
    this.turnPosts.delete(sessionId)
    if (posts.length === 0) {
      return null
    }
    return {
      release: (event) => {
        const linked = this.linkOfSession(sessionId)
        const waiting = linked ? postsWaiting(linked.link, posts) : []
        if (waiting.length === 0 && this.deps.emitTurnEnd(event)) {
          return
        }
        if (linked) {
          this.write(linked, withHeldTurnEnd(linked.link, event, waiting))
        }
      }
    }
  }

  /** Posts a failed message again; its turn's held reply follows once it posts. */
  async retry(sessionId: string, itemId: string): Promise<boolean> {
    const linked = this.linkOfSession(sessionId)
    const clientMessageId = clientMessageIdOf(itemId)
    if (linked?.link.mirrorPosts?.[itemId]?.state !== 'failed' || !clientMessageId) {
      return false
    }
    if (!this.enabled() || !slackMirrorMayPost({ ...linked.link, mirror: true })) {
      return false
    }
    const body = await this.deps.readMessage(sessionId, itemId)
    // Read again after the wait: the link may have changed meanwhile (a mute), and is written whole.
    const current = this.linkOfSession(sessionId)
    if (!body || !current) {
      return false
    }
    this.record(current, itemId, { state: 'posting', at: Date.now() })
    await this.postOnce(sessionId, itemId, clientMessageId, body)
    return true
  }

  /** Gives up on a failed post: it leaves no line, and its turn's reply posts alone. */
  dismiss(sessionId: string, itemId: string): boolean {
    const linked = this.linkOfSession(sessionId)
    if (linked?.link.mirrorPosts?.[itemId]?.state !== 'failed') {
      return false
    }
    this.settled(linked, itemId, null)
    return true
  }

  /** Deletes a posted message from the thread; its badge goes. */
  async deleteFromSlack(sessionId: string, itemId: string): Promise<boolean> {
    const linked = this.linkOfSession(sessionId)
    const clientMessageId = clientMessageIdOf(itemId)
    const cloud = this.enabled()
    const conversation = linked && cloudConversation(linked.link)
    if (
      !linked?.link.bot ||
      linked.link.mirrorPosts?.[itemId]?.state !== 'posted' ||
      !clientMessageId ||
      !cloud ||
      !conversation
    ) {
      return false
    }
    const body: SlackMirrorDeleteBody = { v: 1, clientMessageId, conversation }
    const sent = await slackMirrorCall(this.caller(cloud, linked.link.bot.botId), 'delete', body)
    if (!sent.ok && sent.error !== 'not_found' && sent.error !== 'deleted') {
      return false
    }
    const current = this.linkOfSession(sessionId)
    if (current) {
      this.record(current, itemId, null)
    }
    return true
  }

  /** Turns posting on or off for the chat's next messages; a blocked thread stays off. */
  setMirror(sessionId: string, on: boolean): boolean {
    const linked = this.linkOfSession(sessionId)
    if (!linked || !slackMirrorAvailable(linked.link) || (on && linked.link.mirrorBlocked)) {
      return false
    }
    if (linked.link.mirror !== on || !linked.link.mirrorChosen) {
      this.write(linked, { ...linked.link, mirror: on, mirrorChosen: true })
    }
    return true
  }

  /** What the cloud says of the chat's thread, cached a few minutes per chat. It keeps what the
   *  thread can take on the link: blocked or clear again, and whether it is Slack Connect. */
  async status(sessionId: string): Promise<SlackMirrorStatus | null> {
    const linked = this.linkOfSession(sessionId)
    const cloud = this.enabled()
    if (!linked?.link.bot || !cloud || !slackMirrorAvailable(linked.link)) {
      return null
    }
    const key = `${linked.link.bot.botId}\u0000${linked.link.externalId}`
    const cached = this.statusCache.get(key)
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) {
      return cached.status
    }
    const read = await readSlackMirrorStatus(
      this.caller(cloud, linked.link.bot.botId),
      linked.link.externalId
    )
    const current = this.linkOfSession(sessionId)
    if (!read || !current) {
      return read
    }
    this.statusCache.set(key, { at: Date.now(), status: read })
    this.keepStatus(current, read)
    return read
  }

  /** A default-on chat reads its thread before posting: a Slack Connect thread the owner never
   *  turned on stays in Orca, and an unread one fails with Retry rather than post (Q3). */
  private async postOnce(
    sessionId: string,
    itemId: string,
    clientMessageId: string,
    body: AgentJournalMessageItem
  ): Promise<void> {
    const linked = this.linkOfSession(sessionId)
    if (linked && !linked.link.mirrorChosen && linked.link.mirrorExternal === undefined) {
      await this.status(sessionId)
    }
    const current = this.linkOfSession(sessionId)
    if (!current) {
      return
    }
    const gate = this.gateOf(current.link, sessionId, body)
    if (slackMirrorPosts(gate)) {
      await this.post(sessionId, itemId, clientMessageId, body)
    } else if (slackMirrorMayPost(gate)) {
      this.failed(current, itemId, 'status_unknown')
    } else {
      this.settled(current, itemId, null)
    }
  }

  private async post(
    sessionId: string,
    itemId: string,
    clientMessageId: string,
    body: AgentJournalMessageItem
  ): Promise<void> {
    const linked = this.linkOfSession(sessionId)
    const cloud = this.enabled()
    const conversation = linked && cloudConversation(linked.link)
    const sent =
      linked?.link.bot && conversation && cloud
        ? await postSlackMirrorMessage(this.caller(cloud, linked.link.bot.botId), {
            clientMessageId,
            conversation,
            body,
            orcaName: this.deps.orcaName()
          })
        : null
    const current = this.linkOfSession(sessionId)
    if (!current) {
      return
    }
    if (sent?.ok) {
      const { mirrorBlocked: _cleared, ...open } = current.link
      this.settled({ ...current, link: open }, itemId, { state: 'posted', at: Date.now() })
      return
    }
    this.failed(
      current,
      itemId,
      sent?.error ?? (sent?.status === null || !sent ? 'cloud_unreachable' : 'transient')
    )
  }
}
