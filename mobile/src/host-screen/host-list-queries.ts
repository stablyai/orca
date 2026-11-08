import { getRepoExecutionHostId, parseExecutionHostId } from '../../../src/shared/execution-host'
import type { Query, QueryClient } from '@tanstack/react-query'
import { defineHostQuery } from '../query/host-query'
import { hostQueryKey, type HostQueryTarget } from '../query/host-query-key'
import type { RpcClient } from '../transport/rpc-client'
import {
  applyServerWorkspaces,
  fetchServerWorkspaces,
  NO_SERVER_WORKSPACES,
  ServerRowSnapshots,
  type ServerWorkspaces
} from '../worktree/server-workspaces'
import {
  readWorktreeCatalogSnapshot,
  type WorktreeCatalogSnapshot
} from '../worktree/worktree-catalog-snapshot-client'
import type { Worktree } from '../worktree/workspace-list-types'
import { getCachedWorktrees } from '../cache/worktree-cache'
import type { HostRepoCatalogRow } from './host-screen-reply-schema'
import { hostPlatformRead, hostRepoCatalogSnapshotRead } from './host-screen-operations'
import {
  acceptedMetadata,
  readHostSshTargetLabels,
  settledMetadataReply
} from './host-ssh-target-labels-read'

// The host-wide lists: one per paired host, read on the desktop itself.
export const HOST_LIST_TARGET: HostQueryTarget = { exec: 'local' }
export const NO_HOST_LIST_INPUT = {}

// Agent rows change with no event of their own, so a visible list also polls (host-worktree-catalog).
export const HOST_LIST_POLL_MS = 3000

export const hostWorktreeCatalogQuery = defineHostQuery<
  typeof NO_HOST_LIST_INPUT,
  WorktreeCatalogSnapshot
>({
  family: 'worktree.ps',
  fetch: (client, _target, _input, previous) => readWorktreeCatalogSnapshot(client, previous),
  staleTime: HOST_LIST_POLL_MS,
  gcTime: 30 * 60_000,
  // A hidden page reads nothing on change events; coming back reads what it missed.
  refetchOnWindowFocus: true,
  // Folder workspace changes publish reposChanged, and worktree.ps carries their rows.
  signal: { events: ['worktreesChanged', 'reposChanged'], floorMs: HOST_LIST_POLL_MS }
})

export const hostWorktreeCatalogKey = (hostId: string) =>
  hostQueryKey(hostId, hostWorktreeCatalogQuery.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)

/** The host's catalog as this JS world last read it, or null; a copy, since screens may sort it in place. */
export function cachedHostWorktrees(
  queryClient: QueryClient,
  hostId: string | undefined
): Worktree[] | null {
  if (!hostId) {
    return null
  }
  const cached = queryClient.getQueryData<WorktreeCatalogSnapshot>(hostWorktreeCatalogKey(hostId))
  // Native Home's own catalog read until Home moves onto this query; shown only, never a delta base.
  return cached ? [...cached.worktrees] : (getCachedWorktrees(hostId) as Worktree[] | null)
}

const serverRowSnapshots = {
  deltas: new ServerRowSnapshots(true),
  full: new ServerRowSnapshots(false)
}

// Workspaces on the servers this desktop relays to; a server whose read fails keeps its rows.
export const hostServerWorkspacesQuery = defineHostQuery<{ deltas: boolean }, ServerWorkspaces>({
  family: 'relayHosts.workspaces',
  fetch: async (client, _target, input, previous) => {
    const snapshots = input.deltas ? serverRowSnapshots.deltas : serverRowSnapshots.full
    const fetched = await fetchServerWorkspaces(client, snapshots)
    const held = previous ?? NO_SERVER_WORKSPACES
    return fetched ? applyServerWorkspaces(held, fetched) : held
  },
  staleTime: HOST_LIST_POLL_MS,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: true,
  signal: { events: ['worktreesChanged', 'reposChanged'], floorMs: HOST_LIST_POLL_MS }
})

export type HostRepoCatalog = { snapshotId: string | null; catalog: HostRepoCatalogRow[] }

async function readHostRepoCatalog(
  client: RpcClient,
  previous: HostRepoCatalog | undefined
): Promise<HostRepoCatalog> {
  const held = previous?.snapshotId ? previous : undefined
  const reply = await settledMetadataReply(() =>
    hostRepoCatalogSnapshotRead.request(client, { afterSnapshotId: held?.snapshotId ?? null })
  )
  const repos = reply && hostRepoCatalogSnapshotRead.interpret(reply)
  if (!repos?.accepted) {
    throw new Error('repo.list unavailable')
  }
  const { value } = repos
  if (value.kind === 'catalog') {
    return { snapshotId: value.snapshotId, catalog: value.repos }
  }
  // An unchanged reply for a token the cache no longer holds asks again in full.
  return value.snapshotId === held?.snapshotId ? held : readHostRepoCatalog(client, undefined)
}

export const hostRepoCatalogQuery = defineHostQuery<typeof NO_HOST_LIST_INPUT, HostRepoCatalog>({
  family: 'repo.list',
  fetch: (client, _target, _input, previous) => readHostRepoCatalog(client, previous),
  // Older hosts emit no reposChanged, so a visible list still re-reads once a minute.
  staleTime: 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: true,
  signal: { events: ['reposChanged'] }
})

/** Host badges are read only for mixed-host or SSH catalogs. */
export function catalogNeedsHostLabels(catalog: readonly HostRepoCatalogRow[]): boolean {
  // Count repos, not an id-keyed map: the same repo id may exist on two hosts.
  const hostIds = new Set(catalog.map((repo) => getRepoExecutionHostId(repo)))
  return hostIds.size > 1 || [...hostIds].some((id) => parseExecutionHostId(id)?.kind === 'ssh')
}

export type HostRepoLabels = Awaited<ReturnType<typeof readHostSshTargetLabels>> & {
  platform: NodeJS.Platform | null
}

export const hostRepoLabelsQuery = defineHostQuery<typeof NO_HOST_LIST_INPUT, HostRepoLabels>({
  family: 'repo.hostLabels',
  fetch: async (client) => {
    const [labels, platform] = await Promise.all([
      readHostSshTargetLabels(client),
      settledMetadataReply(() => hostPlatformRead.request(client))
    ])
    return { ...labels, platform: acceptedMetadata(platform, hostPlatformRead.interpret) ?? null }
  },
  staleTime: 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: true,
  // SSH health and the host's own label overrides.
  signal: { events: ['reposChanged', 'sshStateChanged'] }
})

// The host list's own reads, which pull to refresh repeats; project.sections lives with its hook.
const HOST_LIST_FAMILIES: readonly unknown[] = [
  hostWorktreeCatalogQuery.family,
  hostServerWorkspacesQuery.family,
  hostRepoCatalogQuery.family,
  hostRepoLabelsQuery.family,
  'project.sections'
]

export const isHostListQuery = (query: Query): boolean =>
  HOST_LIST_FAMILIES.includes(query.queryKey[2])

/** The host's repo.list rows as this JS world last read them, or null. */
export function cachedHostRepos<Repo>(
  queryClient: QueryClient,
  hostId: string | undefined
): Repo[] | null {
  const cached = hostId
    ? queryClient.getQueryData<HostRepoCatalog>(
        hostQueryKey(hostId, hostRepoCatalogQuery.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)
      )
    : undefined
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo.list rows are the host's Repo records, and the form's repo type is a view of their fields, as listHostRepos reads them.
  return cached ? (cached.catalog as unknown as Repo[]) : null
}
