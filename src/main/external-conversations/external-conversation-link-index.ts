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
import {
  conversationIndexKey,
  EMPTY_LINKED,
  groupEntriesByKey,
  pushBucketEntry,
  sameEntrySlice,
  updateKeyBucket,
  workspaceIndexKey,
  type LinkedConversation
} from './external-conversation-link-buckets'
import type { ConversationKey } from './external-conversation-types'

export type { LinkedConversation }

type LinkRecord = { externalConversations?: unknown }

export type ExternalConversationLinksUpdate = {
  workspace: AgentPaneWorkspace
  externalConversations: unknown
}

export type ExternalConversationLinkWriteOptions = {
  preservesExternalConversationLinks?: boolean
  externalConversationLinksUpdate?: ExternalConversationLinksUpdate
}

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
      options?: ExternalConversationLinkWriteOptions
    ) => void
  ) => unknown
}

const LINK_DOMAINS: readonly string[] = WORKTREE_METADATA_DOMAINS

type LinkIndex = {
  byWorkspace: Map<string, LinkedConversation[]>
  workspaceRank: Map<string, number>
  allOrderExact: boolean
  allCache: LinkedConversation[] | null
  byPane: Map<string, LinkedConversation[]>
  byConversation: Map<string, LinkedConversation[]>
  bySession: Map<string, LinkedConversation[]>
}

type LinkIndexSlot = { current: LinkIndex | null }

function syncDimension(
  indexMap: Map<string, LinkedConversation[]>,
  wsKey: string,
  prev: readonly LinkedConversation[],
  next: readonly LinkedConversation[],
  keyOf: (entry: LinkedConversation) => string,
  ranks: ReadonlyMap<string, number>
): boolean {
  const prevGroups = groupEntriesByKey(prev, keyOf)
  const nextGroups = groupEntriesByKey(next, keyOf)
  const keys = new Set<string>([...prevGroups.keys(), ...nextGroups.keys()])
  for (const key of keys) {
    const before = prevGroups.get(key)
    const after = nextGroups.get(key)
    if (sameEntrySlice(before, after)) {
      continue
    }
    if (!updateKeyBucket(indexMap, key, wsKey, after ?? [], ranks)) {
      return false
    }
  }
  return true
}

function hasStateWrites(
  store: ExternalConversationLinkStore
): store is ExternalConversationLinkStore &
  Required<Pick<ExternalConversationLinkStore, 'onStateWritten'>> {
  return typeof store.onStateWritten === 'function'
}

function* scanWorkspaces(
  store: ExternalConversationLinkStore
): Generator<{ workspace: AgentPaneWorkspace; rawLinks: unknown }> {
  const hosts = new Set<ExecutionHostId>([
    LOCAL_EXECUTION_HOST_ID,
    ...store.getRepos().map(getRepoExecutionHostId)
  ])
  for (const hostId of hosts) {
    const sshHostId = hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
    for (const [worktreeId, meta] of Object.entries(readAllWorktreeMetaForHost(store, hostId))) {
      yield { workspace: { worktreeId, sshHostId }, rawLinks: meta.externalConversations }
    }
  }
  for (const folder of store.getFolderWorkspaces?.() ?? []) {
    yield {
      workspace: { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null },
      rawLinks: folder.externalConversations
    }
  }
}

export function createExternalConversationLinkIndex(
  parseLinks: (value: unknown) => ExternalConversationLink[]
) {
  const linkIndexes = new WeakMap<ExternalConversationLinkStore, LinkIndexSlot>()

  function applyWorkspaceUpdate(
    slot: LinkIndexSlot,
    store: ExternalConversationLinkStore,
    { workspace, externalConversations }: ExternalConversationLinksUpdate
  ): void {
    const current = slot.current
    if (!current) {
      return
    }
    if (
      workspace.sshHostId !== null &&
      !store.getRepos().some((repo) => getRepoExecutionHostId(repo) === workspace.sshHostId)
    ) {
      return
    }
    const wsKey = workspaceIndexKey(workspace)
    const prev = current.byWorkspace.get(wsKey) ?? EMPTY_LINKED
    const prevByLink = new Map<ExternalConversationLink, LinkedConversation>()
    for (const entry of prev) {
      prevByLink.set(entry.link, entry)
    }
    const next =
      Array.isArray(externalConversations) && externalConversations.length > 0
        ? parseLinks(externalConversations).map(
            (link) => prevByLink.get(link) ?? { workspace, link }
          )
        : []
    if ((prev.length === 0 && next.length === 0) || sameEntrySlice(prev, next)) {
      return
    }
    if (
      !syncDimension(
        current.byPane,
        wsKey,
        prev,
        next,
        (entry) => entry.link.paneKey,
        current.workspaceRank
      ) ||
      !syncDimension(
        current.byConversation,
        wsKey,
        prev,
        next,
        (entry) => conversationIndexKey(entry.link),
        current.workspaceRank
      ) ||
      !syncDimension(
        current.bySession,
        wsKey,
        prev,
        next,
        (entry) => entry.link.sessionId,
        current.workspaceRank
      )
    ) {
      slot.current = null
      return
    }
    current.allCache = null
    if (next.length > 0) {
      current.byWorkspace.set(wsKey, next)
      if (!current.workspaceRank.has(wsKey)) {
        current.allOrderExact = false
      }
    } else {
      current.byWorkspace.delete(wsKey)
    }
  }

  function watchLinkWrites(
    store: ExternalConversationLinkStore &
      Required<Pick<ExternalConversationLinkStore, 'onStateWritten'>>
  ): LinkIndexSlot {
    const slot: LinkIndexSlot = { current: null }
    store.onStateWritten((dirtyDomains, options) => {
      if (options?.preservesExternalConversationLinks) {
        return
      }
      if (options?.externalConversationLinksUpdate) {
        applyWorkspaceUpdate(slot, store, options.externalConversationLinksUpdate)
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

  function buildLinkIndex(store: ExternalConversationLinkStore): LinkIndex {
    const all: LinkedConversation[] = []
    const index: LinkIndex = {
      byWorkspace: new Map(),
      workspaceRank: new Map(),
      allOrderExact: true,
      allCache: all,
      byPane: new Map(),
      byConversation: new Map(),
      bySession: new Map()
    }
    // First in scan order wins, as the scans this replaces returned.
    for (const { workspace, rawLinks } of scanWorkspaces(store)) {
      const wsKey = workspaceIndexKey(workspace)
      if (!index.workspaceRank.has(wsKey)) {
        index.workspaceRank.set(wsKey, index.workspaceRank.size)
      }
      if (!Array.isArray(rawLinks) || rawLinks.length === 0) {
        continue
      }
      const entries = parseLinks(rawLinks).map((link) => ({ workspace, link }))
      if (entries.length === 0) {
        continue
      }
      const existing = index.byWorkspace.get(wsKey)
      index.byWorkspace.set(wsKey, existing ? [...existing, ...entries] : entries)
      all.push(...entries)
      for (const linked of entries) {
        pushBucketEntry(index.byPane, linked.link.paneKey, linked)
        pushBucketEntry(index.byConversation, conversationIndexKey(linked.link), linked)
        pushBucketEntry(index.bySession, linked.link.sessionId, linked)
      }
    }
    return index
  }

  function linkIndex(store: ExternalConversationLinkStore, requireExactOrder = false): LinkIndex {
    if (!hasStateWrites(store)) {
      return buildLinkIndex(store)
    }
    let slot = linkIndexes.get(store)
    if (!slot) {
      slot = watchLinkWrites(store)
      linkIndexes.set(store, slot)
    }
    if (!slot.current || (requireExactOrder && !slot.current.allOrderExact)) {
      slot.current = buildLinkIndex(store)
    }
    return slot.current
  }

  return {
    *allLinks(store: ExternalConversationLinkStore): Generator<LinkedConversation> {
      if (hasStateWrites(store)) {
        const current = linkIndex(store, true)
        current.allCache ??= [...current.byWorkspace.entries()]
          .sort(
            ([left], [right]) =>
              current.workspaceRank.get(left)! - current.workspaceRank.get(right)!
          )
          .flatMap(([, entries]) => entries)
        yield* current.allCache
        return
      }
      for (const { workspace, rawLinks } of scanWorkspaces(store)) {
        if (!Array.isArray(rawLinks) || rawLinks.length === 0) {
          continue
        }
        for (const link of parseLinks(rawLinks)) {
          yield { workspace, link }
        }
      }
    },
    findLink: (store: ExternalConversationLinkStore, key: ConversationKey) =>
      linkIndex(store).byConversation.get(conversationIndexKey(key))?.[0] ?? null,
    findLinkForPane: (store: ExternalConversationLinkStore, paneKey: string) =>
      linkIndex(store).byPane.get(paneKey)?.[0] ?? null,
    findLinksForSession: (
      store: ExternalConversationLinkStore,
      sessionId: string
    ): readonly LinkedConversation[] => linkIndex(store).bySession.get(sessionId) ?? EMPTY_LINKED,
    findLinkForSession: (store: ExternalConversationLinkStore, sessionId: string) =>
      linkIndex(store).bySession.get(sessionId)?.[0] ?? null
  }
}
