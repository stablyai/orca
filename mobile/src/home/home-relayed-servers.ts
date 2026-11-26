import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { homeAgentEntries, type HostWorktreeInfo } from '../worktree/catalog/home-worktree-info'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'

/** A desktop's relayed servers as Home read them, with its own identity so a server paired directly lists once. */
export type HomeRelayedServers = {
  installationId?: string
  deltas: boolean
  hosts: MobileRelayHost[]
}

/** One desktop's relayed-servers read, and whether it came on the current connection. */
export type HomeRelayedServersRead = { data: HomeRelayedServers | undefined; live: boolean }

/** A relayed server Home reads, and the one desktop it reads it through. */
export type HomeRelayedServerPick = {
  desktopHostId: string
  deltas: boolean
  server: MobileRelayHost
}

/**
 * The servers whose agents Home lists, each once. A server paired directly lists only there, live or
 * not; one several desktops relay is read through the first live one in Home's order. Only an
 * available server is read: a stopped one's last rows would show its agents as still running.
 */
export function pickRelayedServers(
  hostIds: readonly string[],
  reads: Readonly<Record<string, HomeRelayedServersRead>>
): HomeRelayedServerPick[] {
  const listed = new Set(hostIds.flatMap((hostId) => reads[hostId]?.data?.installationId ?? []))
  const picked = new Set<string>()
  const picks: HomeRelayedServerPick[] = []
  for (const desktopHostId of hostIds) {
    const read = reads[desktopHostId]
    if (!read?.live || !read.data) {
      continue
    }
    for (const server of read.data.hosts) {
      const identity = server.installationId ?? `${desktopHostId}\n${server.hostId}`
      if (server.health !== 'available' || listed.has(identity) || picked.has(identity)) {
        continue
      }
      picked.add(identity)
      picks.push({ desktopHostId, deltas: read.data.deltas, server })
    }
  }
  return picks
}

/** Adds each picked server's agents to its desktop's live ones, labelled with the server. */
export function withRelayedServerAgents(
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>,
  picks: readonly HomeRelayedServerPick[],
  rows: readonly (readonly Worktree[] | undefined)[]
): Readonly<Record<string, HostWorktreeInfo>> {
  let merged: Record<string, HostWorktreeInfo> | null = null
  picks.forEach(({ desktopHostId, server }, at) => {
    const info = merged?.[desktopHostId] ?? worktreeInfo[desktopHostId]
    const serverRows = rows[at]?.filter((row) => row.isArchived !== true)
    if (!info?.agents || !serverRows?.length) {
      return
    }
    const executionHost = { id: server.hostId, label: server.label }
    const relayed = homeAgentEntries(serverRows).map((entry) => ({ ...entry, executionHost }))
    merged ??= { ...worktreeInfo }
    merged[desktopHostId] = { ...info, agents: [...info.agents, ...relayed] }
  })
  return merged ?? worktreeInfo
}
