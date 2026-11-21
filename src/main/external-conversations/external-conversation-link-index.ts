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

export type LinkedConversation<L extends ExternalConversationLink = ExternalConversationLink> = {
  workspace: AgentPaneWorkspace
  link: L
}

const EMPTY_LINKED: readonly LinkedConversation[] = []
const LINK_DOMAINS: readonly string[] = WORKTREE_METADATA_DOMAINS

type LinkIndex = {
  byWorkspace: Map<string, LinkedConversation[]>
  allOrderExact: boolean
  allCache: LinkedConversation[] | null
  byPane: Map<string, LinkedConversation>
  byConversation: Map<string, LinkedConversation>
  bySession: Map<string, LinkedConversation[]>
}

type LinkIndexSlot = { current: LinkIndex | null }

function conversationIndexKey(key: ConversationKey): string {
  return `${key.source}\0${key.externalId}`
}

function workspaceIndexKey({ worktreeId, sshHostId }: AgentPaneWorkspace): string {
  return `${sshHostId ?? ''}\0${worktreeId}`
}

function sameIndexedKeys(
  left: readonly LinkedConversation[],
  right: readonly LinkedConversation[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.link.paneKey === right[index]?.link.paneKey &&
        entry.link.source === right[index]?.link.source &&
        entry.link.externalId === right[index]?.link.externalId &&
        entry.link.sessionId === right[index]?.link.sessionId
    )
  )
}

function insertLinkedEntries(index: LinkIndex, entries: readonly LinkedConversation[]): void {
  for (const linked of entries) {
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
}

function rebuildMapsFromWorkspaces(index: LinkIndex): void {
  index.byPane.clear()
  index.byConversation.clear()
  index.bySession.clear()
  for (const entries of index.byWorkspace.values()) {
    insertLinkedEntries(index, entries)
  }
}

function hasStateWrites(
  store: ExternalConversationLinkStore
): store is ExternalConversationLinkStore &
  Required<Pick<ExternalConversationLinkStore, 'onStateWritten'>> {
  return typeof store.onStateWritten === 'function'
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
    const next =
      Array.isArray(externalConversations) && externalConversations.length > 0
        ? parseLinks(externalConversations).map((link) => ({ workspace, link }))
        : []
    if (prev.length === 0 && next.length === 0) {
      return
    }
    current.allCache = null
    if (sameIndexedKeys(prev, next)) {
      current.byWorkspace.set(wsKey, next)
      for (let i = 0; i < next.length; i += 1) {
        const before = prev[i]!
        const after = next[i]!
        if (current.byPane.get(after.link.paneKey) === before) {
          current.byPane.set(after.link.paneKey, after)
        }
        const conv = conversationIndexKey(after.link)
        if (current.byConversation.get(conv) === before) {
          current.byConversation.set(conv, after)
        }
        const forSession = current.bySession.get(after.link.sessionId)
        const at = forSession ? forSession.indexOf(before) : -1
        if (forSession && at !== -1) {
          forSession[at] = after
        }
      }
      return
    }
    if (prev.length === 0) {
      const collides = next.some(
        (item) =>
          current.byPane.has(item.link.paneKey) ||
          current.byConversation.has(conversationIndexKey(item.link)) ||
          current.bySession.has(item.link.sessionId)
      )
      if (collides) {
        slot.current = null
        return
      }
      current.byWorkspace.set(wsKey, next)
      current.allOrderExact = false
      insertLinkedEntries(current, next)
      return
    }
    if (!current.allOrderExact) {
      slot.current = null
      return
    }
    if (next.length > 0) {
      current.byWorkspace.set(wsKey, next)
    } else {
      current.byWorkspace.delete(wsKey)
    }
    rebuildMapsFromWorkspaces(current)
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

  function* scanAllLinks(store: ExternalConversationLinkStore): Generator<LinkedConversation> {
    const hosts = new Set<ExecutionHostId>([
      LOCAL_EXECUTION_HOST_ID,
      ...store.getRepos().map(getRepoExecutionHostId)
    ])
    for (const hostId of hosts) {
      for (const [worktreeId, meta] of Object.entries(readAllWorktreeMetaForHost(store, hostId))) {
        if (!Array.isArray(meta.externalConversations) || meta.externalConversations.length === 0) {
          continue
        }
        const sshHostId = hostId === LOCAL_EXECUTION_HOST_ID ? null : hostId
        for (const link of parseLinks(meta.externalConversations)) {
          yield { workspace: { worktreeId, sshHostId }, link }
        }
      }
    }
    for (const folder of store.getFolderWorkspaces?.() ?? []) {
      for (const link of parseLinks(folder.externalConversations)) {
        yield { workspace: { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null }, link }
      }
    }
  }

  function buildLinkIndex(store: ExternalConversationLinkStore): LinkIndex {
    const all: LinkedConversation[] = []
    const index: LinkIndex = {
      byWorkspace: new Map(),
      allOrderExact: true,
      allCache: all,
      byPane: new Map(),
      byConversation: new Map(),
      bySession: new Map()
    }
    // First in scan order wins, as the scans this replaces returned.
    for (const linked of scanAllLinks(store)) {
      all.push(linked)
      const wsKey = workspaceIndexKey(linked.workspace)
      const inWorkspace = index.byWorkspace.get(wsKey)
      if (inWorkspace) {
        inWorkspace.push(linked)
      } else {
        index.byWorkspace.set(wsKey, [linked])
      }
    }
    rebuildMapsFromWorkspaces(index)
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
        current.allCache ??= [...current.byWorkspace.values()].flat()
        yield* current.allCache
        return
      }
      yield* scanAllLinks(store)
    },
    findLink: (store: ExternalConversationLinkStore, key: ConversationKey) =>
      linkIndex(store).byConversation.get(conversationIndexKey(key)) ?? null,
    findLinkForPane: (store: ExternalConversationLinkStore, paneKey: string) =>
      linkIndex(store).byPane.get(paneKey) ?? null,
    findLinksForSession: (
      store: ExternalConversationLinkStore,
      sessionId: string
    ): readonly LinkedConversation[] => linkIndex(store).bySession.get(sessionId) ?? EMPTY_LINKED,
    findLinkForSession: (store: ExternalConversationLinkStore, sessionId: string) =>
      (linkIndex(store).bySession.get(sessionId) ?? EMPTY_LINKED)[0] ?? null
  }
}
