import * as z from 'zod'
import {
  MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY
} from '../../../src/shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { NO_HOST_LIST_INPUT } from '../host-screen/catalog/host-list-queries'
import { defineHostQuery } from '../query/host-query'
import { decodeHostStatusReply, readHostStatusReply } from '../query/host-status-query'
import { relaysToServers } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { relayHostsFeed } from '../worktree/execution-hosts/relay-hosts-feed'
import { ServerRowSnapshots } from '../worktree/execution-hosts/server-workspaces'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import type { HomeRelayedServers } from './home-relayed-servers'

// Same pace as the workspace list's poll; a busy agent's notices can arrive many times a second.
const HOME_RELAYED_REFRESH_FLOOR_MS = 3000

// Home's own snapshots, so its single-server reads never prune the workspace list's.
const homeServerRowSnapshots = {
  deltas: new ServerRowSnapshots(true),
  full: new ServerRowSnapshots(false)
}

/** A desktop's relayed servers, read on open, foreground and relayHostsChanged; never on a timer. */
export const homeRelayedServersQuery = defineHostQuery<
  typeof NO_HOST_LIST_INPUT,
  HomeRelayedServers
>({
  family: 'relayHosts.homeServers',
  fetch: async (client, _target, _input, previous) => {
    const status = await readHostStatusReply(client)
      .then((reply) => decodeHostStatusReply(reply)?.status ?? null)
      .catch(() => null)
    const capabilities = status?.capabilities ?? []
    const installationId = status?.hostDescriptor?.installationId
    // A desktop that can't announce row changes would leave them stale, and Home doesn't poll.
    const announces =
      relaysToServers(client, capabilities) &&
      capabilities.includes(MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY)
    const hosts = announces ? await relayHostsFeed(client).read() : []
    const deltas = capabilities.includes(MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY)
    if (hosts !== null) {
      homeServerRowSnapshots.deltas.retain(client, deltas ? hosts : [])
      homeServerRowSnapshots.full.retain(client, deltas ? [] : hosts)
    }
    return {
      ...(installationId ? { installationId } : {}),
      deltas,
      hosts: hosts ? [...hosts] : (previous?.hosts ?? [])
    }
  },
  staleTime: HOME_RELAYED_REFRESH_FLOOR_MS,
  gcTime: Infinity,
  refetchOnWindowFocus: true,
  signal: { events: ['relayHostsChanged'], floorMs: HOME_RELAYED_REFRESH_FLOOR_MS },
  // Kept so a direct pairing that is offline still claims its server; its hosts are never shown from disk.
  persist: {
    version: 1,
    dataSchema: z.object({
      installationId: z.string().optional(),
      deltas: z.boolean(),
      hosts: z.array(z.never())
    }),
    strip: (data) => ({
      ...(data.installationId ? { installationId: data.installationId } : {}),
      deltas: data.deltas,
      hosts: []
    })
  }
})

/**
 * One relayed server's rows through one desktop; re-read only when that server's rows change. `rowChanges`
 * keys the read, so a server upgraded in place to publish them is read once more and watched.
 */
export const homeRelayedServerRowsQuery = defineHostQuery<
  { deltas: boolean; rowChanges: boolean },
  readonly Worktree[]
>({
  family: 'relayHosts.homeServerRows',
  fetch: async (client, target, input, previous) => {
    const snapshots = input.deltas ? homeServerRowSnapshots.deltas : homeServerRowSnapshots.full
    // A failed read keeps the last rows; Home hides them once the server is not available.
    return (await snapshots.readOne(client, target.exec)) ?? previous ?? []
  },
  staleTime: HOME_RELAYED_REFRESH_FLOOR_MS,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: true,
  // A server that comes back mounts its read again, so a host list change re-reads no other server.
  signal: {
    events: ['relayHostRowsChanged'],
    floorMs: HOME_RELAYED_REFRESH_FLOOR_MS,
    matches: (event, target) =>
      event.type === 'relayHostRowsChanged' && event.hostId === target.exec
  }
})
