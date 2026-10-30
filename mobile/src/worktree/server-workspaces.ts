import { z } from 'zod'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { RpcClient } from '../transport/rpc-client'
import { relayHostsFeed } from './relay-hosts-feed'
import { relayHostWorktreesRead } from './server-workspace-operations'
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

async function fetchHostRows(
  client: RpcOperationSender,
  hostId: ExecutionHostId
): Promise<Worktree[] | null> {
  try {
    const reply = relayHostWorktreesRead.interpret(
      await relayHostWorktreesRead.request(client, { hostId })
    )
    if (!reply.accepted || !reply.value.worktrees) {
      return null
    }
    const schema = serverRowSchema(hostId)
    return reply.value.worktrees.flatMap((row) => {
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
  client: RpcClient
): Promise<FetchedServerWorkspaces | null> {
  const hosts = await relayHostsFeed(client).read()
  if (!hosts) {
    return null
  }
  return { hosts, rows: await Promise.all(hosts.map((host) => fetchHostRows(client, host.hostId))) }
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
