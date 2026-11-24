import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import { isConversationReport } from './external-conversation-turn-opener'
import {
  conversationPlaceText,
  type ChatMailPlace,
  type ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'
import type { AgentPaneWorkspace } from '../agent-hooks/observations/agent-transition-detector'
import {
  readWorkspaceRecord,
  writeWorkspaceRecord
} from '../runtime/workspaces/metadata/workspace-activity-records'
import type { ConversationKey } from './external-conversation-types'
import { revokeAgentSessionPublicationFences } from '../runtime/agent-session/agent-session-publication-fence'
import {
  createExternalConversationLinkIndex,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-link-index'
import { linksOf, parseExternalConversationLink } from './external-conversation-link-parser'

export { linksOf }
export type { ExternalConversationLinkStore, LinkedConversation }

/** Skip malformed links so hand edits or newer host shapes do not break reads. */
export function readLinks(
  store: ExternalConversationLinkStore,
  workspace: AgentPaneWorkspace
): ExternalConversationLink[] {
  const record = readWorkspaceRecord(store, workspace)
  return linksOf(record?.externalConversations)
}

export function sameConversation(link: ExternalConversationLink, key: ConversationKey): boolean {
  return link.source === key.source && link.externalId === key.externalId
}

/** A pane answers one conversation, so linking it takes it from any earlier one (e.g. a bot's Chat). */
export function writeLink(
  store: ExternalConversationLinkStore,
  workspace: AgentPaneWorkspace,
  link: ExternalConversationLink
): void {
  const prior = readLinks(store, workspace)
  const others = prior.filter(
    (existing) => !sameConversation(existing, link) && existing.paneKey !== link.paneKey
  )
  const replaced = prior.filter(
    (existing) => sameConversation(existing, link) || existing.paneKey === link.paneKey
  )
  const before = replaced[0]
  if (
    replaced.length !== 1 ||
    !before ||
    before.sessionId !== link.sessionId ||
    before.bot?.botId !== link.bot?.botId ||
    !sameConversation(before, link)
  ) {
    revokeAgentSessionPublicationFences(
      [link, ...replaced].map((key) => JSON.stringify(['conversation', key.source, key.externalId]))
    )
  }
  const validated = parseExternalConversationLink(link) ?? link
  writeWorkspaceRecord(store, workspace, { externalConversations: [...others, validated] })
  // The record writer refuses ambiguous hosts; verify that the link actually persisted.
  if (!readLinks(store, workspace).some((current) => current.paneKey === link.paneKey)) {
    throw new Error('external_conversation_link_unwritten')
  }
}

/** Drops a conversation's link, as when its chat is gone; null when there was none. */
export function removeLink(
  store: ExternalConversationLinkStore,
  key: ConversationKey
): LinkedConversation | null {
  const linked = findLink(store, key)
  if (linked) {
    revokeAgentSessionPublicationFences([
      JSON.stringify(['conversation', key.source, key.externalId])
    ])
    const kept = readLinks(store, linked.workspace).filter((link) => !sameConversation(link, key))
    writeWorkspaceRecord(store, linked.workspace, { externalConversations: kept })
  }
  return linked
}

const index = createExternalConversationLinkIndex((value) => linksOf(value))

/** Read canonical rows on every host; the locator map can hide same-path workspaces on other hosts. */
export const allLinks = index.allLinks
export const findLink = index.findLink
export const findLinkForPane = index.findLinkForPane
export const findLinksForSession = index.findLinksForSession
export const findLinkForSession = index.findLinkForSession

/** Whether the chat answers a Slack thread, so its replies are written in Slack's markup. */
export function sessionRepliesInSlack(
  store: ExternalConversationLinkStore,
  sessionId: string
): boolean {
  return findLinksForSession(store, sessionId).some(({ link }) => link.source === 'slack')
}

/** The conversation a chat is bound to, as its bot reads it, and whether its answer to this mail
 *  lands there (only mail finishing its ask does); null for an unlinked chat or a bot's own Chat. */
export function chatMailPlace(
  store: ExternalConversationLinkStore,
  sessionId: string,
  from: AgentMessageSource
): ChatMailPlace | null {
  const linked = findLinkForSession(store, sessionId)
  if (!linked || linked.link.bot?.kind === 'bot-chat') {
    return null
  }
  const mail = { kind: 'message' as const, role: 'user' as const, blocks: [], from }
  return { place: conversationPlaceText(linked.link), answersThere: isConversationReport(mail) }
}

/** The outside thread one of these chat sessions is linked to (by pane), if any. */
export function chatLinkSource(
  store: ExternalConversationLinkStore,
  sessionIds: readonly string[]
): ConversationKey['source'] | null {
  for (const sessionId of sessionIds) {
    const linked = findLinkForPane(
      store,
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
    )
    if (linked) {
      return linked.link.source
    }
  }
  return null
}

export function findConversationChat(
  store: ExternalConversationLinkStore,
  key: ConversationKey,
  botId?: string
): { worktreeId: string; sessionId: string } | null {
  const linked = findLink(store, key)
  return linked && (!botId || linked.link.bot?.botId === botId)
    ? { worktreeId: linked.workspace.worktreeId, sessionId: linked.link.sessionId }
    : null
}

export function requireLink(
  store: ExternalConversationLinkStore,
  key: ConversationKey
): LinkedConversation {
  const linked = findLink(store, key)
  if (!linked) {
    throw new Error('external_conversation_not_found')
  }
  return linked
}
