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

// A desktop without server-row deltas gets only the host id: its params are strict.
function serverCatalogRequest(hostId: ExecutionHostId, deltas: boolean): WorktreeCatalogRequest {
  return async (client, snapshot) => {
    const reply = deltas
      ? relayHostWorktreeSnapshotRead.interpret(
          await relayHostWorktreeSnapshotRead.request(client, { hostId, ...snapshot })
        )
      : relayHostWorktreesRead.interpret(await relayHostWorktreesRead.request(client, { hostId }))
    return reply.accepted
      ? { accepted: true, value: reply.value }
      : { accepted: false, code: 'request_failed' }
  }
}

/** Per-server catalog snapshots; row deltas only when the desktop advertises them. */
export class ServerRowSnapshots {
  // Per client, so a slow read on a replaced client can never take a snapshot back from the new one.
  private readonly byClient = new WeakMap<
    RpcClient,
    Map<ExecutionHostId, WorktreeCatalogSnapshotClient>
  >()

  constructor(readonly deltas: boolean) {}

  async read(client: RpcClient, hosts: readonly MobileRelayHost[]): Promise<(Worktree[] | null)[]> {
    let byHost = this.byClient.get(client)
    if (!byHost) {
      byHost = new Map()
      this.byClient.set(client, byHost)
    }
    const listed = new Set<ExecutionHostId>(hosts.map((host) => host.hostId))
    for (const hostId of byHost.keys()) {
      if (!listed.has(hostId)) {
        byHost.delete(hostId)
      }
    }
    return Promise.all(hosts.map((host) => this.readHost(client, byHost, host.hostId)))
  }

  private async readHost(
    client: RpcClient,
    byHost: Map<ExecutionHostId, WorktreeCatalogSnapshotClient>,
    hostId: ExecutionHostId
  ): Promise<Worktree[] | null> {
    let snapshots = byHost.get(hostId)
    if (!snapshots) {
      snapshots = new WorktreeCatalogSnapshotClient(serverCatalogRequest(hostId, this.deltas))
      byHost.set(hostId, snapshots)
    }
    try {
      const rows = await snapshots.read(client, hostId)
      const schema = serverRowSchema(hostId)
      return (
        rows?.flatMap((row) => {
          const parsed = schema.safeParse(row)
          return parsed.success ? [parsed.data] : []
        }) ?? null
      )
    } catch {
      return null
    }
  }
}

export type FetchedServerWorkspaces = {
  hosts: readonly MobileRelayHost[]
  rows: readonly (readonly Worktree[] | null)[]
}

export async function fetchServerWorkspaces(
  client: RpcClient,
  snapshots: ServerRowSnapshots
): Promise<FetchedServerWorkspaces | null> {
  const hosts = await relayHostsFeed(client).read()
  return hosts ? { hosts, rows: await snapshots.read(client, hosts) } : null
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
