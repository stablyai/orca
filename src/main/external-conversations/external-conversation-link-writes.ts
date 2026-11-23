import { externalConversationTitle } from '../../shared/external-conversation-title'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AgentPaneWorkspace } from '../agent-hooks/observations/agent-transition-detector'
import { chatLink, type LinkableChat } from './external-conversation-chat-delivery'
import {
  allLinks,
  findLink,
  linksOf,
  readLinks,
  sameConversation,
  writeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import type { ConversationKey } from './external-conversation-types'

/** Keeps a fact on the conversation's link; false when it is gone or already says so. A known
 *  workspace is read alone, never the whole inventory. */
export function writeLinkFact(
  store: ExternalConversationLinkStore,
  key: ConversationKey,
  fact:
    | Pick<ExternalConversationLink, 'place'>
    | Pick<ExternalConversationLink, 'lastTurn'>
    | Pick<ExternalConversationLink, 'adoptedTurn'>,
  workspace?: AgentPaneWorkspace
): boolean {
  const kept = workspace && readLinks(store, workspace).find((link) => sameConversation(link, key))
  const linked = workspace ? (kept ? { workspace, link: kept } : null) : findLink(store, key)
  const next = linked && { ...linked.link, ...fact }
  if (
    !next ||
    (next.place === linked.link.place &&
      next.lastTurn === linked.link.lastTurn &&
      next.adoptedTurn === linked.link.adoptedTurn)
  ) {
    return false
  }
  if (next.adoptedTurn === undefined) {
    delete next.adoptedTurn
  }
  writeLink(store, linked.workspace, next)
  return true
}

/** Marks a bot thread seen at its chat's first open, wherever it is opened; false when no unseen
 *  thread runs in that chat. Bot threads live in bot homes, which are folder workspaces. */
export function markThreadSeen(
  store: ExternalConversationLinkStore,
  sessionId: string,
  at = Date.now()
): boolean {
  for (const folder of store.getFolderWorkspaces?.() ?? []) {
    const link = linksOf(folder.externalConversations).find(
      (entry) => entry.sessionId === sessionId && entry.seenAt === null
    )
    if (link) {
      writeLink(
        store,
        { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null },
        {
          ...link,
          seenAt: at
        }
      )
      return true
    }
  }
  return false
}

/** A chat link, unless this exact one exists; a conversation names one place and a chat has one conversation. */
export function writeChatLink(
  store: ExternalConversationLinkStore,
  key: ConversationKey,
  chat: LinkableChat,
  /** The text that started the conversation; a relink keeps the title it already had. */
  text?: string
): LinkedConversation | null {
  const { worktreeId, sessionId } = chat
  const existing = findLink(store, key)
  if (existing?.link.sessionId === sessionId && existing.workspace.worktreeId === worktreeId) {
    return null
  }
  const title =
    existing?.link.title ?? (text === undefined ? '' : externalConversationTitle(key.source, text))
  // Sends follow the first link found, and events and replies name a chat's conversation by its pane.
  // A bot's chat is the exception: its Home chat answers whichever conversation wrote to it last.
  // A bot's own thread is new to the owner until its chat is first opened; a relink keeps that.
  const seenAt = existing ? existing.link.seenAt : chat.bot?.kind === 'bot' ? null : undefined
  const workspace = { worktreeId, sshHostId: null }
  const base = chatLink(key, chat)
  const adoptedTurn = readLinks(store, workspace).find(
    (link) => link.sessionId === sessionId && link.paneKey === base.paneKey
  )?.adoptedTurn
  const kept = existing?.link
  const link: ExternalConversationLink = {
    ...base,
    // A rebind changes the recipient, never custody of the running turn's private opener.
    ...(adoptedTurn ? { adoptedTurn } : {}),
    // The thread's own facts go with it to its new chat.
    ...(kept?.opener ? { opener: kept.opener } : {}),
    ...(kept?.mirror !== undefined ? { mirror: kept.mirror } : {}),
    ...(kept?.mirrorBlocked ? { mirrorBlocked: kept.mirrorBlocked } : {}),
    ...(kept?.mirrorChosen ? { mirrorChosen: kept.mirrorChosen } : {}),
    ...(kept?.mirrorExternal !== undefined ? { mirrorExternal: kept.mirrorExternal } : {}),
    // Held replies wait on these posts, so both move together.
    ...(kept?.mirrorPosts ? { mirrorPosts: kept.mirrorPosts } : {}),
    ...(kept?.mirrorHeld ? { mirrorHeld: kept.mirrorHeld } : {}),
    ...(title ? { title } : {}),
    ...(seenAt !== undefined ? { seenAt } : {})
  }
  if (
    !chat.bot &&
    (existing || [...allLinks(store)].some((linked) => linked.link.paneKey === link.paneKey))
  ) {
    throw new Error('external_conversation_already_linked')
  }
  writeLink(store, workspace, link)
  return { workspace, link }
}
