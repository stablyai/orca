import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import { isConversationReport } from './external-conversation-turn-opener'
import { z } from 'zod'
import {
  CONNECTOR_SOURCES,
  SLACK_MIRROR_BLOCKS,
  SLACK_MIRROR_POST_STATES,
  conversationPlaceText,
  type ChatMailPlace,
  type ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import { NATIVE_CHAT_AGENTS } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AgentPaneWorkspace } from '../agent-hooks/observations/agent-transition-detector'
import {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  type WorkspaceRecordStore
} from '../runtime/workspaces/metadata/workspace-activity-records'
import {
  savedWorkspaceCatalog,
  WORKTREE_METADATA_DOMAINS
} from '../persistence/profile-save-domains'
import type { ConversationKey } from './external-conversation-types'
import { revokeAgentSessionPublicationFences } from '../runtime/agent-session/agent-session-publication-fence'

type LinkRecord = { externalConversations?: unknown }

export type ExternalConversationLinkStore = WorkspaceRecordStore<
  LinkRecord,
  { externalConversations: ExternalConversationLink[] }
> & {
  getAllWorktreeMeta: () => Record<string, LinkRecord & { hostId?: ExecutionHostId }>
  getAllWorktreeMetaForHost?: (
    hostId: ExecutionHostId
  ) => Record<string, LinkRecord & { hostId?: ExecutionHostId }>
  getFolderWorkspaces?: () => readonly (LinkRecord & { id: string })[]
  /** Real stores report every mutation's domains, which lets lookups reuse one link index. */
  onStateWritten?: (listener: (dirtyDomains: readonly string[] | undefined) => void) => unknown
}

export type LinkedConversation<L extends ExternalConversationLink = ExternalConversationLink> = {
  workspace: AgentPaneWorkspace
  link: L
}

// A terminal pane's link from an older Orca has no session and is skipped.
const ExternalConversationLinkSchema = z.object({
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string(),
  sessionId: z.string().min(1),
  agent: z.enum(NATIVE_CHAT_AGENTS),
  paneKey: z.string(),
  bot: z.object({ kind: z.enum(['bot', 'bot-chat']), botId: z.string().min(1) }).optional(),
  title: z.string().optional(),
  place: z.string().optional(),
  lastTurn: z.enum(['conversation', 'orca']).optional(),
  adoptedTurn: z.object({ itemId: z.string().min(1), at: z.number().positive() }).optional(),
  seenAt: z.number().nullable().optional(),
  // Mirror facts read loosely: a malformed one is dropped alone, never the link.
  opener: z
    .object({
      role: z.enum(['owner', 'member']),
      name: z.string().max(200).optional(),
      dm: z.literal(true).optional()
    })
    .optional()
    .catch(undefined),
  mirror: z.boolean().optional().catch(undefined),
  mirrorBlocked: z.enum(SLACK_MIRROR_BLOCKS).optional().catch(undefined),
  mirrorPosts: z
    .record(
      z.string(),
      z.object({
        state: z.enum(SLACK_MIRROR_POST_STATES),
        at: z.number(),
        error: z.string().max(64).optional()
      })
    )
    .optional()
    .catch(undefined),
  mirrorChosen: z.literal(true).optional().catch(undefined),
  mirrorExternal: z.boolean().optional().catch(undefined),
  mirrorHeld: z
    .array(z.object({ event: z.unknown(), waiting: z.array(z.string()) }))
    .optional()
    .catch(undefined),
  createdAt: z.number()
})

/** Skip malformed links so hand edits or newer host shapes do not break reads. */
export function readLinks(
  store: ExternalConversationLinkStore,
  workspace: AgentPaneWorkspace
): ExternalConversationLink[] {
  const record = readWorkspaceRecord(store, workspace)
  return linksOf(record?.externalConversations)
}

export function linksOf(value: unknown): ExternalConversationLink[] {
  const entries: unknown[] = Array.isArray(value) ? value : []
  return entries.flatMap((entry) => {
    const parsed = ExternalConversationLinkSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
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
  writeWorkspaceRecord(store, workspace, { externalConversations: [...others, link] })
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

/** Read canonical rows on every host; the locator map can hide same-path workspaces on other hosts. */
export function* allLinks(store: ExternalConversationLinkStore): Generator<LinkedConversation> {
  const hosts = new Set<ExecutionHostId>([
    LOCAL_EXECUTION_HOST_ID,
    ...store.getRepos().map(getRepoExecutionHostId)
  ])
  for (const hostId of hosts) {
    for (const [worktreeId, meta] of Object.entries(readAllWorktreeMetaForHost(store, hostId))) {
      const sshHostId = hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
      for (const link of linksOf(meta.externalConversations)) {
        yield { workspace: { worktreeId, sshHostId }, link }
      }
    }
  }
  for (const folder of store.getFolderWorkspaces?.() ?? []) {
    for (const link of linksOf(folder.externalConversations)) {
      yield { workspace: { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null }, link }
    }
  }
}

/** Whether the chat answers a Slack thread, so its replies are written in Slack's markup. */
export function sessionRepliesInSlack(
  store: ExternalConversationLinkStore,
  sessionId: string
): boolean {
  for (const { link } of allLinks(store)) {
    if (link.sessionId === sessionId && link.source === 'slack') {
      return true
    }
  }
  return false
}

/** The conversation a chat is bound to, as its bot reads it, and whether its answer to this mail
 *  lands there (only mail finishing its ask does); null for an unlinked chat or a bot's own Chat. */
export function chatMailPlace(
  store: ExternalConversationLinkStore,
  sessionId: string,
  from: AgentMessageSource
): ChatMailPlace | null {
  const linked = [...allLinks(store)].find(({ link }) => link.sessionId === sessionId)
  if (!linked || linked.link.bot?.kind === 'bot-chat') {
    return null
  }
  const mail = { kind: 'message' as const, role: 'user' as const, blocks: [], from }
  return { place: conversationPlaceText(linked.link), answersThere: isConversationReport(mail) }
}

type LinkIndex = {
  byPane: Map<string, LinkedConversation>
  byConversation: Map<string, LinkedConversation>
}

type LinkIndexSlot = { current: LinkIndex | null }

const linkIndexes = new WeakMap<ExternalConversationLinkStore, LinkIndexSlot>()

const LINK_DOMAINS: readonly string[] = WORKTREE_METADATA_DOMAINS

function conversationIndexKey(key: ConversationKey): string {
  return `${key.source}\0${key.externalId}`
}

function buildLinkIndex(store: ExternalConversationLinkStore): LinkIndex {
  const index: LinkIndex = {
    byPane: new Map(),
    byConversation: new Map()
  }
  // First in scan order wins, as the scans this replaces returned.
  for (const linked of allLinks(store)) {
    if (!index.byPane.has(linked.link.paneKey)) {
      index.byPane.set(linked.link.paneKey, linked)
    }
    const conversation = conversationIndexKey(linked.link)
    if (!index.byConversation.has(conversation)) {
      index.byConversation.set(conversation, linked)
    }
  }
  return index
}

function hasStateWrites(
  store: ExternalConversationLinkStore
): store is ExternalConversationLinkStore &
  Required<Pick<ExternalConversationLinkStore, 'onStateWritten'>> {
  return typeof store.onStateWritten === 'function'
}

function watchLinkWrites(
  store: ExternalConversationLinkStore &
    Required<Pick<ExternalConversationLinkStore, 'onStateWritten'>>
): LinkIndexSlot {
  const slot: LinkIndexSlot = { current: null }
  // Synchronous with the write, so no lookup can see a removed or moved link. One metadata row's
  // write can change which row other locators and hosts resolve to, so any such write drops it.
  store.onStateWritten((dirtyDomains) => {
    if (
      savedWorkspaceCatalog(dirtyDomains) ||
      dirtyDomains?.some((domain) => LINK_DOMAINS.includes(domain))
    ) {
      slot.current = null
    }
  })
  return slot
}

/** Status events look links up far more often than links, metadata or the catalog change. */
function linkIndex(store: ExternalConversationLinkStore): LinkIndex {
  if (!hasStateWrites(store)) {
    return buildLinkIndex(store)
  }
  let slot = linkIndexes.get(store)
  if (!slot) {
    slot = watchLinkWrites(store)
    linkIndexes.set(store, slot)
  }
  slot.current ??= buildLinkIndex(store)
  return slot.current
}

export function findLink(
  store: ExternalConversationLinkStore,
  key: ConversationKey
): LinkedConversation | null {
  return linkIndex(store).byConversation.get(conversationIndexKey(key)) ?? null
}

export function findLinkForPane(
  store: ExternalConversationLinkStore,
  paneKey: string
): LinkedConversation | null {
  return linkIndex(store).byPane.get(paneKey) ?? null
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
