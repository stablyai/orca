import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AgentPaneWorkspace } from '../agent-hooks/observations/agent-transition-detector'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import {
  savedWorkspaceCatalog,
  WORKTREE_METADATA_DOMAINS
} from '../persistence/profile-save-domains'
import type { WorkspaceRecordStore } from '../runtime/workspaces/metadata/workspace-activity-records'
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
  onStateWritten?: (
    listener: (
      dirtyDomains: readonly string[] | undefined,
      options?: { preservesExternalConversationLinks?: boolean }
    ) => void
  ) => unknown
}

export type LinkedConversation<L extends ExternalConversationLink = ExternalConversationLink> = {
  workspace: AgentPaneWorkspace
  link: L
}

const EMPTY_LINKED: readonly LinkedConversation[] = []
const LINK_DOMAINS: readonly string[] = WORKTREE_METADATA_DOMAINS

type LinkIndex = {
  all: readonly LinkedConversation[]
  byPane: Map<string, LinkedConversation>
  byConversation: Map<string, LinkedConversation>
  bySession: Map<string, LinkedConversation[]>
}

type LinkIndexSlot = { current: LinkIndex | null }

function conversationIndexKey(key: ConversationKey): string {
  return `${key.source}\0${key.externalId}`
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
  // Synchronous with the write, so no lookup can see a removed or moved link. Only non-migrating
  // single-identity updates that leave externalConversations untouched keep the index.
  store.onStateWritten((dirtyDomains, options) => {
    if (options?.preservesExternalConversationLinks) {
      return
    }
    if (
      savedWorkspaceCatalog(dirtyDomains) ||
      dirtyDomains?.some((domain) => LINK_DOMAINS.includes(domain))
    ) {
      slot.current = null
    }
  })
  return slot
}

export function createExternalConversationLinkIndex(
  parseLinks: (value: unknown) => ExternalConversationLink[]
) {
  const linkIndexes = new WeakMap<ExternalConversationLinkStore, LinkIndexSlot>()

  function* scanAllLinks(store: ExternalConversationLinkStore): Generator<LinkedConversation> {
    const hosts = new Set<ExecutionHostId>([
      LOCAL_EXECUTION_HOST_ID,
      ...store.getRepos().map(getRepoExecutionHostId)
    ])
    for (const hostId of hosts) {
      for (const [worktreeId, meta] of Object.entries(readAllWorktreeMetaForHost(store, hostId))) {
        if (
          !Array.isArray(meta.externalConversations) ||
          meta.externalConversations.length === 0
        ) {
          continue
        }
        const sshHostId = hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
        for (const link of parseLinks(meta.externalConversations)) {
          yield { workspace: { worktreeId, sshHostId }, link }
        }
      }
    }
    for (const folder of store.getFolderWorkspaces?.() ?? []) {
      if (
        !Array.isArray(folder.externalConversations) ||
        folder.externalConversations.length === 0
      ) {
        continue
      }
      for (const link of parseLinks(folder.externalConversations)) {
        yield { workspace: { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null }, link }
      }
    }
  }

  function buildLinkIndex(store: ExternalConversationLinkStore): LinkIndex {
    const all: LinkedConversation[] = []
    const index: LinkIndex = {
      all,
      byPane: new Map(),
      byConversation: new Map(),
      bySession: new Map()
    }
    // First in scan order wins, as the scans this replaces returned.
    for (const linked of scanAllLinks(store)) {
      all.push(linked)
      if (!index.byPane.has(linked.link.paneKey)) {
        index.byPane.set(linked.link.paneKey, linked)
      }
      const conversation = conversationIndexKey(linked.link)
      if (!index.byConversation.has(conversation)) {
        index.byConversation.set(conversation, linked)
      }
      const forSession = index.bySession.get(linked.link.sessionId)
      if (forSession) {
        forSession.push(linked)
      } else {
        index.bySession.set(linked.link.sessionId, [linked])
      }
    }
    return index
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

  return {
    *allLinks(store: ExternalConversationLinkStore): Generator<LinkedConversation> {
      if (hasStateWrites(store)) {
        yield* linkIndex(store).all
        return
      }
      yield* scanAllLinks(store)
    },
    findLink(
      store: ExternalConversationLinkStore,
      key: ConversationKey
    ): LinkedConversation | null {
      return linkIndex(store).byConversation.get(conversationIndexKey(key)) ?? null
    },
    findLinkForPane(
      store: ExternalConversationLinkStore,
      paneKey: string
    ): LinkedConversation | null {
      return linkIndex(store).byPane.get(paneKey) ?? null
    },
    findLinksForSession(
      store: ExternalConversationLinkStore,
      sessionId: string
    ): readonly LinkedConversation[] {
      return linkIndex(store).bySession.get(sessionId) ?? EMPTY_LINKED
    },
    findLinkForSession(
      store: ExternalConversationLinkStore,
      sessionId: string
    ): LinkedConversation | null {
      return (linkIndex(store).bySession.get(sessionId) ?? EMPTY_LINKED)[0] ?? null
    }
  }
}
