import { z } from 'zod'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { relayHostsListRead, relayHostWorktreesRead } from './server-workspace-operations'
import type { Worktree } from './workspace-list-types'
import { areWorktreeListsEqual } from './worktree-list-snapshot'

/** The desktop's servers and their rows, each stamped by the desktop with the server's host id. */
export type ServerWorkspaces = { hosts: readonly MobileRelayHost[]; worktrees: readonly Worktree[] }

export const NO_SERVER_WORKSPACES: ServerWorkspaces = { hosts: [], worktrees: [] }

/** A server that needs an update reads as blocked, which the shared table labels "Update needed". */
export function serverHostHealth(host: MobileRelayHost): ExecutionHostHealth {
  return host.relay === 'update-needed' ? 'blocked' : host.health
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

/** One listing round: the desktop's servers, and per server its rows or null when unread. */
export type FetchedServerWorkspaces = {
  hosts: readonly MobileRelayHost[]
  rows: readonly (readonly Worktree[] | null)[]
}

/** The servers' rows through the desktop's one listing path; null when it did not answer. */
export async function fetchServerWorkspaces(
  client: RpcOperationSender
): Promise<FetchedServerWorkspaces | null> {
  const listed = relayHostsListRead.interpret(await relayHostsListRead.request(client))
  if (!listed.accepted) {
    return null
  }
  const hosts = listed.value
  return { hosts, rows: await Promise.all(hosts.map((host) => fetchHostRows(client, host.hostId))) }
}

/**
 * A server whose rows were not read keeps those shown; one the desktop dropped loses its rows.
 * An unchanged poll returns `previous` itself, so the list does not rebuild every few seconds.
 */
export function applyServerWorkspaces(
  previous: ServerWorkspaces,
  fetched: FetchedServerWorkspaces
): ServerWorkspaces {
  const worktrees = fetched.hosts.flatMap(
    (host, index) =>
      fetched.rows[index] ?? previous.worktrees.filter((row) => row.hostId === host.hostId)
  )
  // Why kept: screens key per-server clients on `hosts`, which rows changing must not rebuild.
  const hosts =
    JSON.stringify(fetched.hosts) === JSON.stringify(previous.hosts)
      ? previous.hosts
      : fetched.hosts
  const unchanged = hosts === previous.hosts && areWorktreeListsEqual(worktrees, previous.worktrees)
  return unchanged ? previous : { hosts, worktrees }
}
