// Posts the owner's Orca-typed messages into their bot chat's Slack thread, and holds the turn's
// reply until those posts settled, so Slack never shows an answer before its question.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { SlackMirrorDeleteBody } from '../../shared/connectors/connector-slack-mirror-contract'
import {
  conversationOpener,
  slackMirrorAvailable,
  slackMirrorDefault,
  slackMirrorMayPost
} from '../../shared/connectors/slack-mirror-state'
import {
  cloudConversation,
  type ConnectorAsker
} from '../../shared/connectors/connector-cloud-contract'
import type { AdmittedMessage } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { readLinks, type LinkedConversation } from './external-conversation-links'
import { postsWaiting, withHeldTurnEnd, type ConversationTurnEnd } from './slack-mirror-held'
import { slackMirrorCall } from './slack-mirror-cloud'
import { clientMessageIdOf, slackMirrorCloudId } from './slack-mirror-handover'
import { SlackMirrorPosts, slackMirrorGone } from './slack-mirror-posts'

export type { SlackMirrorDeps } from './slack-mirror-posts'

/** A turn some of whose messages posted: its end goes once those posts settled. */
export type SlackMirrorTurn = { release: (event: ConversationTurnEnd) => void }

function isPersonsMessage(body: AgentJournalMessageItem): boolean {
  return body.role === 'user' && !body.from && !body.origin && !body.command
}

export class SlackMirror extends SlackMirrorPosts {
  private readonly turnPosts = new Map<string, Set<string>>()

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

  /** A message a chat admitted: the owner's own, in a chat that posts to its thread, posts there.
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
    if (!isPersonsMessage(message.body)) {
      return
    }
    const itemId = agentJournalSubmissionKey(message.clientMessageId)
    const posts = this.turnPosts.get(message.sessionId) ?? new Set<string>()
    if (message.firstAdmittedAs) {
      // Handed over again: one message is one post, which moves to the item the chat shows now.
      const was = this.handedOver(message.sessionId, message.firstAdmittedAs, itemId)
      if (was !== null) {
        posts.delete(was)
        this.turnPosts.set(message.sessionId, posts.add(itemId))
      }
      return
    }
    if (!slackMirrorMayPost(link) || !this.enabled()) {
      return
    }
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
    const post = linked?.link.mirrorPosts?.[itemId]
    const clientMessageId = clientMessageIdOf(itemId)
    if (post?.state !== 'failed' || !clientMessageId) {
      return false
    }
    if (!this.enabled() || !slackMirrorMayPost({ ...linked!.link, mirror: true })) {
      return false
    }
    const { error: _error, ...kept } = post
    if (post.clientMessageId) {
      // Moved from an earlier send: that send finishes, then shows what the message says now.
      this.record(linked!, itemId, { ...kept, state: 'posting', at: Date.now() })
      await this.converge(sessionId, itemId, false)
      return true
    }
    const body = await this.deps.readMessage(sessionId, itemId)
    if (!body) {
      return false
    }
    this.record(linked!, itemId, { ...kept, state: 'posting', at: Date.now() })
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
    const post = linked?.link.mirrorPosts?.[itemId]
    const clientMessageId = post && slackMirrorCloudId(itemId, post)
    const cloud = this.enabled()
    const conversation = linked && cloudConversation(linked.link)
    if (
      !linked?.link.bot ||
      post?.state !== 'posted' ||
      !clientMessageId ||
      !cloud ||
      !conversation
    ) {
      return false
    }
    const body: SlackMirrorDeleteBody = { v: 1, clientMessageId, conversation }
    const sent = await slackMirrorCall(this.caller(cloud, linked.link.bot.botId), 'delete', body)
    if (!slackMirrorGone(sent)) {
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
}
