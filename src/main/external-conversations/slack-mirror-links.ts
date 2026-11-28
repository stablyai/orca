// The Slack mirror's facts on each chat's link: its posts' states and the turn ends held for them.
import type {
  ExternalConversationLink,
  SlackMirrorBlocked,
  SlackMirrorPost
} from '../../shared/connectors/external-conversation-link'
import type { SlackMirrorStatus } from '../../shared/connectors/connector-slack-mirror-contract'
import {
  slackMirrorAvailable,
  slackMirrorBlockOf,
  withSlackMirrorPost
} from '../../shared/connectors/slack-mirror-state'
import {
  allLinks,
  findLink,
  findLinksForSession,
  writeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import { releaseHeldTurnEnds, withHeldTurnEnd, type ConversationTurnEnd } from './slack-mirror-held'

export type SlackMirrorLinkDeps = {
  store: ExternalConversationLinkStore
  /** Tells the watching connector a turn's end; false while none watches, so it stays held. */
  emitTurnEnd: (event: ConversationTurnEnd) => boolean
  /** Link facts changed, so clients reread the workspace. */
  onLinked?: () => void
}

export class SlackMirrorLinks {
  constructor(protected readonly deps: SlackMirrorLinkDeps) {
    // A post this process didn't start was cut short by a quit: it reads as failed, with Retry.
    for (const linked of allLinks(deps.store)) {
      const posting = Object.entries(linked.link.mirrorPosts ?? {}).filter(
        ([, post]) => post.state === 'posting'
      )
      let link = linked.link
      for (const [itemId] of posting) {
        const failed = { state: 'failed' as const, at: Date.now(), error: 'interrupted' }
        link = { ...link, mirrorPosts: withSlackMirrorPost(link.mirrorPosts, itemId, failed) }
      }
      if (posting.length > 0) {
        this.write(linked, link)
      }
    }
  }

  /** Turn ends held while no connector watched, told once one does. */
  flushHeld(): void {
    for (const linked of allLinks(this.deps.store)) {
      if (linked.link.mirrorHeld?.length) {
        this.release(linked, null)
      }
    }
  }

  /** A post went (or was given up): its line changes, and turn ends that waited only on it go. */
  protected settled(
    linked: LinkedConversation,
    itemId: string,
    post: SlackMirrorPost | null
  ): void {
    const recorded = {
      ...linked.link,
      mirrorPosts: withSlackMirrorPost(linked.link.mirrorPosts, itemId, post)
    }
    this.release({ ...linked, link: recorded }, itemId)
  }

  private release(linked: LinkedConversation, itemId: string | null): void {
    const { link, ready } = releaseHeldTurnEnds(linked.link, itemId)
    const unsent = ready.filter((event) => !this.deps.emitTurnEnd(event))
    this.write(
      linked,
      unsent.reduce((kept, event) => withHeldTurnEnd(kept, event, []), link)
    )
  }

  protected record(linked: LinkedConversation, itemId: string, post: SlackMirrorPost | null): void {
    this.write(linked, {
      ...linked.link,
      mirrorPosts: withSlackMirrorPost(linked.link.mirrorPosts, itemId, post)
    })
  }

  /** A post that didn't go: its failed line, and the thread blocked when Slack says it can't take it. */
  protected failed(linked: LinkedConversation, itemId: string, error: string): void {
    const blocked = slackMirrorBlockOf(error)
    this.write(linked, {
      ...linked.link,
      ...(blocked ? { mirrorBlocked: blocked } : {}),
      mirrorPosts: withSlackMirrorPost(linked.link.mirrorPosts, itemId, {
        state: 'failed',
        at: Date.now(),
        error: error.slice(0, 64)
      })
    })
  }

  /** Keeps what the thread can take: blocked or clear again, and whether it is Slack Connect. */
  protected keepStatus(linked: LinkedConversation, status: SlackMirrorStatus): void {
    const blocked: SlackMirrorBlocked | undefined =
      status.missing || status.archived
        ? 'thread_unavailable'
        : status.notInChannel
          ? 'not_in_channel'
          : undefined
    const { mirrorBlocked: _was, ...rest } = linked.link
    const next = {
      ...rest,
      ...(blocked ? { mirrorBlocked: blocked } : {}),
      mirrorExternal: status.external === true
    }
    if (
      next.mirrorBlocked !== linked.link.mirrorBlocked ||
      next.mirrorExternal !== linked.link.mirrorExternal
    ) {
      this.write(linked, next)
    }
  }

  protected write(linked: LinkedConversation, next: ExternalConversationLink): boolean {
    try {
      if (findLink(this.deps.store, next)?.link.isolatedSlack) {
        return false
      }
      writeLink(this.deps.store, linked.workspace, next)
      this.deps.onLinked?.()
      return true
    } catch (error) {
      console.warn('[connectors] could not keep a Slack mirror fact', error)
      return false
    }
  }

  /** The chat's own Slack thread link; a bot's Chat (which answers DMs) has none. */
  protected linkOfSession(sessionId: string): LinkedConversation | null {
    return (
      findLinksForSession(this.deps.store, sessionId).find(({ link }) =>
        slackMirrorAvailable(link)
      ) ?? null
    )
  }
}
