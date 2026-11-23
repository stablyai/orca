// A message handed over again as a later send keeps its one Slack post: the post's record moves to
// the item the chat shows now, and remembers the send it went under.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  ExternalConversationLink,
  SlackMirrorPost
} from '../../shared/connectors/external-conversation-link'
import { withSlackMirrorPost } from '../../shared/connectors/slack-mirror-state'
import { slackMirrorContent, slackMirrorTypist } from './slack-mirror-cloud'

/** The send id behind a person's message item; null for any other item. */
export function clientMessageIdOf(itemId: string): string | null {
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && 'clientMessageId' in identity
    ? identity.clientMessageId
    : null
}

/** The send a post went to Slack under: its own item's, unless it moved there from another. */
export function slackMirrorCloudId(itemId: string, post: SlackMirrorPost): string | null {
  return post.clientMessageId ?? clientMessageIdOf(itemId)
}

/** The post of a message first admitted as `firstAdmittedAs`, wherever a hand-over moved it. */
export function slackMirrorPostOf(
  link: Pick<ExternalConversationLink, 'mirrorPosts'>,
  firstAdmittedAs: string
): { itemId: string; post: SlackMirrorPost } | null {
  const itemId = agentJournalSubmissionKey(firstAdmittedAs)
  const own = link.mirrorPosts?.[itemId]
  if (own) {
    return { itemId, post: own }
  }
  for (const [key, post] of Object.entries(link.mirrorPosts ?? {})) {
    if (post.firstAdmittedAs === firstAdmittedAs) {
      return { itemId: key, post }
    }
  }
  return null
}

/** Where a post started for `itemId` under `cloudId` is kept now; null once it is gone. */
export function slackMirrorPostKey(
  link: Pick<ExternalConversationLink, 'mirrorPosts'>,
  itemId: string,
  cloudId: string
): string | null {
  const own = link.mirrorPosts?.[itemId]
  if (own && slackMirrorCloudId(itemId, own) === cloudId) {
    return itemId
  }
  for (const [key, post] of Object.entries(link.mirrorPosts ?? {})) {
    if (post.clientMessageId === cloudId) {
      return key
    }
  }
  return null
}

/** The link with the post moved from `from` to `to`, and replies held for it waiting on `to`. */
export function movedSlackMirrorPost(
  link: ExternalConversationLink,
  from: string,
  to: string,
  post: SlackMirrorPost
): ExternalConversationLink {
  return {
    ...link,
    mirrorPosts: withSlackMirrorPost(withSlackMirrorPost(link.mirrorPosts, from, null), to, post),
    ...(link.mirrorHeld
      ? {
          mirrorHeld: link.mirrorHeld.map((held) => ({
            ...held,
            waiting: held.waiting.map((waited) => (waited === from ? to : waited))
          }))
        }
      : {})
  }
}

/** How the post of what was sent turns into what the message says now. Text alone edits in place;
 *  other files or another typist (or no text left, which an edit cannot carry) post it afresh. */
export function slackMirrorChange(
  sent: AgentJournalMessageItem,
  current: AgentJournalMessageItem,
  edited: boolean
): 'none' | 'update' | 'replace' {
  const was = slackMirrorContent(sent)
  const now = slackMirrorContent(current)
  if (
    !now.text ||
    was.paths.join('\n') !== now.paths.join('\n') ||
    JSON.stringify(slackMirrorTypist(sent)) !== JSON.stringify(slackMirrorTypist(current))
  ) {
    return 'replace'
  }
  return !edited && was.text === now.text ? 'none' : 'update'
}

/** A record as it settles: the same post, now in `state`. */
export function settledSlackMirrorPost(
  post: SlackMirrorPost | undefined,
  next: Pick<SlackMirrorPost, 'state' | 'error'> & { edited?: true }
): SlackMirrorPost {
  const { error: _error, ...kept } = post ?? { state: next.state, at: 0 }
  return { ...kept, ...next, at: Date.now() }
}
