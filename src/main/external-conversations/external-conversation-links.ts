import { z } from 'zod'
import {
  CONNECTOR_SOURCES,
  type ExternalConversationLink
} from '../../shared/external-conversation-link'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { normalizeAgentProviderSession } from '../../shared/agent-session-resume'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { AgentPaneWorkspace } from '../agent-hooks/agent-transition-detector'
import {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  type WorkspaceRecordStore
} from '../runtime/sidebar-inputs/sort-stamp-records'
import { CONNECTOR_AGENTS } from './connector-agents'
import type { ConversationKey } from './external-conversation-types'

type LinkRecord = { externalConversations?: unknown }

/** The workspace records links live on; the runtime's store satisfies it. */
export type ExternalConversationLinkStore = WorkspaceRecordStore<
  LinkRecord,
  { externalConversations: ExternalConversationLink[] }
> & {
  getAllWorktreeMeta: () => Record<string, LinkRecord & { hostId?: ExecutionHostId }>
  getAllWorktreeMetaForHost?: (
    hostId: ExecutionHostId
  ) => Record<string, LinkRecord & { hostId?: ExecutionHostId }>
  getFolderWorkspaces?: () => readonly (LinkRecord & { id: string })[]
}

export type LinkedConversation = { workspace: AgentPaneWorkspace; link: ExternalConversationLink }

const ExternalConversationLinkSchema = z.object({
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string(),
  paneKey: z.string(),
  agent: z.enum(CONNECTOR_AGENTS),
  // A malformed session drops alone: the link still delivers, it just cannot reopen.
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

/** The workspace record's links; malformed entries (hand edits, a newer host's shape) are skipped. */
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

/** Replaces this conversation's link on the workspace record, host-qualified like any meta write. */
export function writeLink(
  store: ExternalConversationLinkStore,
  workspace: AgentPaneWorkspace,
  link: ExternalConversationLink
): void {
  const others = readLinks(store, workspace).filter((existing) => !sameConversation(existing, link))
  writeWorkspaceRecord(store, workspace, { externalConversations: [...others, link] })
  // The record writer skips a workspace whose host it cannot name rather than guess.
  if (!readLinks(store, workspace).some((current) => current.paneKey === link.paneKey)) {
    throw new Error('external_conversation_link_unwritten')
  }
}

/**
 * Every persisted link, read from every host's canonical rows each time: the locator-keyed map
 * keeps only one host's row per id, and a removed, renamed or re-adopted workspace is never
 * answered from a cache.
 */
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

export function findLink(
  store: ExternalConversationLinkStore,
  key: ConversationKey
): LinkedConversation | null {
  for (const linked of allLinks(store)) {
    if (sameConversation(linked.link, key)) {
      return linked
    }
  }
  return null
}
