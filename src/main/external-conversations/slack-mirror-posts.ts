// A message's one post to its chat's Slack thread: posting it, and keeping it once the message is
// handed over again as a later send.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  SlackMirrorDeleteBody,
  SlackMirrorStatus,
  SlackMirrorUpdateBody
} from '../../shared/connectors/connector-slack-mirror-contract'
import type { SlackMirrorPost } from '../../shared/connectors/external-conversation-link'
import {
  slackMirrorAvailable,
  slackMirrorMayPost,
  slackMirrorPosts
} from '../../shared/connectors/slack-mirror-state'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'
import { SlackMirrorLinks, type SlackMirrorLinkDeps } from './slack-mirror-links'
import {
  mirroringCloud,
  postSlackMirrorMessage,
  readSlackMirrorStatus,
  slackMirrorCall,
  slackMirrorContent,
  type SlackMirrorCall,
  type SlackMirrorCloud
} from './slack-mirror-cloud'
import {
  clientMessageIdOf,
  movedSlackMirrorPost,
  settledSlackMirrorPost,
  slackMirrorChange,
  slackMirrorCloudId,
  slackMirrorPostKey,
  slackMirrorPostOf
} from './slack-mirror-handover'

export type SlackMirrorDeps = SlackMirrorLinkDeps & {
  cloud: () => SlackMirrorCloud | null
  /** The Orca account's name, posted beside the words. */
  orcaName: () => string
  /** A bot's "Post my Orca messages to Slack threads I start"; undefined reads as on. */
  botSetting: (botId: string) => boolean | undefined
  /** A message of the chat, read back for Retry and for a hand-over's edits. */
  readMessage: (sessionId: string, itemId: string) => Promise<AgentJournalMessageItem | null>
  signal: AbortSignal
  random?: () => number
}

const STATUS_TTL_MS = 5 * 60_000
const UNREADABLE: ConnectorResult<unknown> = {
  ok: false,
  status: null,
  error: 'transient',
  retryAfterMs: null
}

/** Slack no longer has the post, which is what a delete wanted. */
export function slackMirrorGone(answer: ConnectorResult<unknown>): boolean {
  return answer.ok || answer.error === 'not_found' || answer.error === 'deleted'
}

export class SlackMirrorPosts extends SlackMirrorLinks {
  private readonly statusCache = new Map<string, { at: number; status: SlackMirrorStatus }>()

  constructor(protected override readonly deps: SlackMirrorDeps) {
    super(deps)
  }

  protected enabled(): SlackMirrorCloud | null {
    return mirroringCloud(this.deps.cloud())
  }

  protected caller(cloud: SlackMirrorCloud, botId: string): SlackMirrorCall {
    return { cloud, botId, signal: this.deps.signal, random: this.deps.random ?? Math.random }
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
  protected async postOnce(
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
    const key = current && slackMirrorPostKey(current.link, itemId, clientMessageId)
    if (current && slackMirrorPosts(current.link)) {
      await this.post(sessionId, itemId, clientMessageId, body)
    } else if (current && key && slackMirrorMayPost(current.link)) {
      this.failed(current, key, 'status_unknown')
    } else if (current) {
      this.settled(current, key ?? itemId, null)
    }
  }

  /** Posts under `clientMessageId`. A post a hand-over moved meanwhile settles where it is now, once
   *  it also shows what the message says now. */
  protected async post(
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
    const key = slackMirrorPostKey(current.link, itemId, clientMessageId)
    if (!key) {
      // Dismissed or deleted meanwhile: it stays gone, and nothing waits on it.
      this.settled(current, itemId, null)
      return
    }
    if (sent?.ok) {
      const { mirrorBlocked: _cleared, ...open } = current.link
      if (key !== itemId) {
        this.write(current, open)
        await this.converge(sessionId, key, true)
        return
      }
      const post = settledSlackMirrorPost(open.mirrorPosts?.[key], { state: 'posted' })
      this.settled({ ...current, link: open }, key, post)
      return
    }
    this.failed(
      current,
      key,
      sent?.error ?? (sent?.status === null || !sent ? 'cloud_unreachable' : 'transient')
    )
  }

  /** A message handed over again as `itemId`: its one post moves there, keeping the send it went
   *  under, and then shows what the message says now. Returns where the post was; null when it has
   *  none (never posted, dismissed or deleted), so it never posts a second time. */
  protected handedOver(sessionId: string, firstAdmittedAs: string, itemId: string): string | null {
    const linked = this.linkOfSession(sessionId)
    const found = linked && slackMirrorPostOf(linked.link, firstAdmittedAs)
    const cloudId = found && slackMirrorCloudId(found.itemId, found.post)
    if (!linked || !found || !cloudId) {
      return null
    }
    if (found.itemId === itemId) {
      return itemId
    }
    const posted = found.post.state === 'posted'
    const moved: SlackMirrorPost = {
      ...found.post,
      clientMessageId: cloudId,
      firstAdmittedAs,
      ...(posted ? { state: 'posting', at: Date.now() } : {})
    }
    this.write(linked, movedSlackMirrorPost(linked.link, found.itemId, itemId, moved))
    // A post still going converges once it answers; a failed one waits for Retry.
    if (posted) {
      void this.converge(sessionId, itemId, true)
    }
    return found.itemId
  }

  /** Brings the post under the record's earlier send to what `itemId` says now: no call when
   *  nothing changed, an edit in place for text, and otherwise a delete and a fresh post under the
   *  item's own send. `posted`: Slack already took the earlier send. */
  protected async converge(sessionId: string, itemId: string, posted: boolean): Promise<void> {
    const linked = this.linkOfSession(sessionId)
    const record = linked?.link.mirrorPosts?.[itemId]
    const cloudId = record?.clientMessageId
    const cloud = this.enabled()
    const conversation = linked && cloudConversation(linked.link)
    if (!linked?.link.bot || !record || !cloudId || !cloud || !conversation) {
      if (linked && record) {
        this.failed(linked, itemId, 'cloud_unreachable')
      }
      return
    }
    const call = this.caller(cloud, linked.link.bot.botId)
    const [sent, current] = await Promise.all([
      this.deps.readMessage(sessionId, agentJournalSubmissionKey(cloudId)),
      this.deps.readMessage(sessionId, itemId)
    ])
    if (!sent || !current) {
      // Nothing to compare: a posted one stays as Slack has it; a failed one keeps Retry.
      const kept: ConnectorResult<unknown> = posted ? { ok: true, value: undefined } : UNREADABLE
      return this.convergeSettled(sessionId, itemId, cloudId, kept)
    }
    let answer: ConnectorResult<unknown> = { ok: true, value: undefined }
    if (!posted) {
      // A failed earlier send finishes first, so a half-posted one is found, never posted twice.
      answer = await postSlackMirrorMessage(call, {
        clientMessageId: cloudId,
        conversation,
        body: sent,
        orcaName: this.deps.orcaName()
      })
    }
    const change = answer.ok ? slackMirrorChange(sent, current, record.edited === true) : null
    if (change === 'update') {
      const text = slackMirrorContent(current).text
      const update: SlackMirrorUpdateBody = { v: 1, clientMessageId: cloudId, conversation, text }
      answer = await slackMirrorCall(call, 'update', update)
    } else if (change === 'replace' || (!answer.ok && answer.error === 'deleted')) {
      const remove: SlackMirrorDeleteBody = { v: 1, clientMessageId: cloudId, conversation }
      const removed = change === 'replace' ? await slackMirrorCall(call, 'delete', remove) : answer
      const now = this.linkOfSession(sessionId)
      const key = now && slackMirrorPostKey(now.link, itemId, cloudId)
      const own = key && clientMessageIdOf(key)
      if (!slackMirrorGone(removed) || !now || !key || !own) {
        return this.convergeSettled(sessionId, itemId, cloudId, removed)
      }
      // Recorded before the fresh post, so a quit between them leaves Retry for the fresh one.
      const { clientMessageId: _sentAs, edited: _edited, ...fresh } = now.link.mirrorPosts![key]!
      this.record(now, key, { ...fresh, state: 'posting', at: Date.now() })
      const words = key === itemId ? current : await this.deps.readMessage(sessionId, key)
      return words
        ? this.post(sessionId, key, own, words)
        : this.convergeSettled(sessionId, key, own, UNREADABLE)
    }
    this.convergeSettled(sessionId, itemId, cloudId, answer, change === 'update')
  }

  private convergeSettled(
    sessionId: string,
    itemId: string,
    cloudId: string,
    answer: ConnectorResult<unknown>,
    edited = false
  ): void {
    const linked = this.linkOfSession(sessionId)
    const key = linked && slackMirrorPostKey(linked.link, itemId, cloudId)
    if (!linked || !key) {
      return
    }
    if (key !== itemId) {
      // Handed over again meanwhile: it converges to that send's words instead.
      void this.converge(sessionId, key, answer.ok)
      return
    }
    const post = linked.link.mirrorPosts?.[key]
    if (answer.ok) {
      const next = settledSlackMirrorPost(post, { state: 'posted' })
      this.settled(linked, key, edited ? { ...next, edited } : next)
    } else if (answer.error === 'deleted') {
      // Deleted from Slack meanwhile: it stays deleted.
      this.settled(linked, key, null)
    } else {
      this.record(linked, key, { ...post!, ...(edited ? { edited } : {}) })
      this.failed(this.linkOfSession(sessionId)!, key, answer.error ?? 'transient')
    }
  }
}
