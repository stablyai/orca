import { z } from 'zod'
import {
  CONNECTOR_SOURCES,
  type ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import { normalizeAgentProviderSession } from '../../shared/agent-session/lifecycle/agent-session-resume'
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
import { CONNECTOR_AGENTS } from './connector-agents'
import type { ConversationKey } from './external-conversation-types'

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

export type LinkedConversation = { workspace: AgentPaneWorkspace; link: ExternalConversationLink }

const ExternalConversationLinkSchema = z.object({
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string(),
  paneKey: z.string(),
  agent: z.enum(CONNECTOR_AGENTS),
  // A malformed provider session prevents reopening, but must not discard a usable link.
  providerSession: z
    .unknown()
    .transform((raw) => normalizeAgentProviderSession(raw) ?? undefined)
    .optional(),
  captureHostId: z
    .unknown()
    .transform(
      (raw) => (typeof raw === 'string' ? normalizeExecutionHostId(raw) : null) ?? undefined
    )
    .optional(),
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

function linksOf(value: unknown): ExternalConversationLink[] {
  const entries: unknown[] = Array.isArray(value) ? value : []
  return entries.flatMap((entry) => {
    const parsed = ExternalConversationLinkSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

function sameConversation(link: ExternalConversationLink, key: ConversationKey): boolean {
  return link.source === key.source && link.externalId === key.externalId
}

export function writeLink(
  store: ExternalConversationLinkStore,
  workspace: AgentPaneWorkspace,
  link: ExternalConversationLink
): void {
  const others = readLinks(store, workspace).filter((existing) => !sameConversation(existing, link))
  writeWorkspaceRecord(store, workspace, { externalConversations: [...others, link] })
  // The record writer refuses ambiguous hosts; verify that the link actually persisted.
  if (!readLinks(store, workspace).some((current) => current.paneKey === link.paneKey)) {
    throw new Error('external_conversation_link_unwritten')
  }
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
