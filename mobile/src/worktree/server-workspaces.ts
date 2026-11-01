import { z } from 'zod'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import type { RpcClient } from '../transport/rpc-client'
import { relayHostsFeed } from './relay-hosts-feed'
import {
  relayHostWorktreeSnapshotRead,
  relayHostWorktreesRead
} from './server-workspace-operations'
import {
  WorktreeCatalogSnapshotClient,
  type WorktreeCatalogRequest
} from './worktree-catalog-snapshot-client'
import type { Worktree } from './workspace-list-types'
import { areWorktreeListsEqual } from './worktree-list-snapshot'

export type ServerWorkspaces = { hosts: readonly MobileRelayHost[]; worktrees: readonly Worktree[] }

export const NO_SERVER_WORKSPACES: ServerWorkspaces = { hosts: [], worktrees: [] }

export function serverHostHealth(host: MobileRelayHost): ExecutionHostHealth {
  return host.relay === 'update-needed' ? 'blocked' : host.health
}

// Why: a phone never starts or connects the desktop's own WSL host, so the badge says where to.
export function serverHostHealthLabel(host: MobileRelayHost): string | undefined {
  if (host.stoppedOnDesktop) {
    return 'Start on computer'
  }
  return host.unavailableOnDesktop ? 'Open on computer' : undefined
}

export function serverHostHealthLabels(
  hosts: readonly MobileRelayHost[]
): ReadonlyMap<ExecutionHostId, string> {
  return new Map(
    hosts.flatMap((host) => {
      const label = serverHostHealthLabel(host)
      return label ? [[host.hostId, label] as const] : []
    })
  )
}

export function withServerHosts<Value>(
  desktop: ReadonlyMap<ExecutionHostId, Value>,
  hosts: readonly MobileRelayHost[],
  read: (host: MobileRelayHost) => Value
): ReadonlyMap<ExecutionHostId, Value> {
  if (hosts.length === 0) {
    return desktop
  }
  const merged = new Map(desktop)
  for (const host of hosts) {
    merged.set(host.hostId, read(host))
  }
  return merged
}

function serverRowSchema(hostId: ExecutionHostId) {
  return z.custom<Worktree>(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      'hostId' in row &&
      row.hostId === hostId &&
      'worktreeId' in row &&
      typeof row.worktreeId === 'string' &&
      'repoId' in row &&
      typeof row.repoId === 'string'
  )
}

function serverCatalogRequest(hostId: ExecutionHostId): WorktreeCatalogRequest {
  return async (client, snapshot) => {
    const reply = relayHostWorktreeSnapshotRead.interpret(
      await relayHostWorktreeSnapshotRead.request(client, { hostId, ...snapshot })
    )
    return reply.accepted
      ? { accepted: true, value: reply.value }
      : { accepted: false, code: 'request_failed' }
  }
}

/** Per-server snapshots, for a desktop that answers server rows as snapshots and row deltas. */
export class ServerRowSnapshots {
  private readonly byHost = new Map<ExecutionHostId, WorktreeCatalogSnapshotClient>()

  forHost(hostId: ExecutionHostId): WorktreeCatalogSnapshotClient {
    let snapshots = this.byHost.get(hostId)
    if (!snapshots) {
      snapshots = new WorktreeCatalogSnapshotClient({ request: serverCatalogRequest(hostId) })
      this.byHost.set(hostId, snapshots)
    }
    return snapshots
  }
}

async function readHostRows(
  client: RpcClient,
  hostId: ExecutionHostId,
  snapshots: ServerRowSnapshots | null
): Promise<readonly unknown[] | null> {
  if (!snapshots) {
    const reply = relayHostWorktreesRead.interpret(
      await relayHostWorktreesRead.request(client, { hostId })
    )
    return reply.accepted ? reply.value.worktrees : null
  }
  const hostSnapshots = snapshots.forHost(hostId)
  const fetched = await hostSnapshots.fetch(client, hostId)
  // Null (refused, not fetched yet, or a delta that cannot rebuild) keeps the rows shown.
  return fetched.kind === 'response' ? hostSnapshots.admit(fetched.pending) : null
}

async function fetchHostRows(
  client: RpcClient,
  hostId: ExecutionHostId,
  snapshots: ServerRowSnapshots | null
): Promise<Worktree[] | null> {
  try {
    const rows = await readHostRows(client, hostId, snapshots)
    if (!rows) {
      return null
    }
    const schema = serverRowSchema(hostId)
    return rows.flatMap((row) => {
      const parsed = schema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  } catch {
    return null
  }
}

export type FetchedServerWorkspaces = {
  hosts: readonly MobileRelayHost[]
  rows: readonly (readonly Worktree[] | null)[]
}

export async function fetchServerWorkspaces(
  client: RpcClient,
  snapshots: ServerRowSnapshots | null = null
): Promise<FetchedServerWorkspaces | null> {
  const hosts = await relayHostsFeed(client).read()
  if (!hosts) {
    return null
  }
  return {
    hosts,
    rows: await Promise.all(hosts.map((host) => fetchHostRows(client, host.hostId, snapshots)))
  }
}

// Keep rows when their server read failed; drop them only when the desktop drops the server.
// Preserve identity on unchanged polls so consumers avoid rebuilding.
export function applyServerWorkspaces(
  previous: ServerWorkspaces,
  fetched: FetchedServerWorkspaces
): ServerWorkspaces {
  let previousByHost: Map<ExecutionHostId | undefined, Worktree[]> | undefined
  const previousRows = (hostId: ExecutionHostId): readonly Worktree[] => {
    if (previousByHost === undefined) {
      previousByHost = new Map()
      for (const row of previous.worktrees) {
        const host = row.hostId
        const rows = previousByHost.get(host)
        if (rows) {
          rows.push(row)
        } else {
          previousByHost.set(host, [row])
        }
      }
    }
    return previousByHost.get(hostId) ?? []
  }
  const worktrees = fetched.hosts.flatMap(
    (host, index) => fetched.rows[index] ?? previousRows(host.hostId)
  )
  // Keep hosts identity when only rows change; screens key their per-server clients on it.
  const hosts =
    JSON.stringify(fetched.hosts) === JSON.stringify(previous.hosts)
      ? previous.hosts
      : fetched.hosts
  const unchanged = hosts === previous.hosts && areWorktreeListsEqual(worktrees, previous.worktrees)
  return unchanged ? previous : { hosts, worktrees }
}
