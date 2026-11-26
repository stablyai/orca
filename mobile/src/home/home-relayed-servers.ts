import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import {
  homeAgentEntries,
  type HomeAgentEntry,
  type HostWorktreeInfo
} from '../worktree/catalog/home-worktree-info'
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

type ProjectedServerAgents = {
  hostId: MobileRelayHost['hostId']
  label: string
  entries: readonly HomeAgentEntry[]
}

const projectedServerAgents = new WeakMap<readonly Worktree[], ProjectedServerAgents>()

function relayedServerAgentEntries(
  serverRows: readonly Worktree[],
  server: Pick<MobileRelayHost, 'hostId' | 'label'>
): readonly HomeAgentEntry[] {
  const cached = projectedServerAgents.get(serverRows)
  if (cached && cached.hostId === server.hostId && cached.label === server.label) {
    return cached.entries
  }
  const activeRows = serverRows.filter((row) => row.isArchived !== true)
  let entries: readonly HomeAgentEntry[] = []
  if (activeRows.length > 0) {
    const executionHost = { id: server.hostId, label: server.label }
    entries = homeAgentEntries(activeRows).map((entry) => ({ ...entry, executionHost }))
  }
  projectedServerAgents.set(serverRows, {
    hostId: server.hostId,
    label: server.label,
    entries
  })
  return entries
}

/** Adds each picked server's agents to its desktop's live ones, labelled with the server. */
export function withRelayedServerAgents(
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>,
  picks: readonly HomeRelayedServerPick[],
  rows: readonly (readonly Worktree[] | undefined)[]
): Readonly<Record<string, HostWorktreeInfo>> {
  let appendedByDesktop: Map<string, HomeAgentEntry[]> | null = null
  for (let at = 0; at < picks.length; at += 1) {
    const pick = picks[at]
    if (!pick) {
      continue
    }
    const { desktopHostId, server } = pick
    const info = worktreeInfo[desktopHostId]
    const serverRows = rows[at]
    if (!info?.agents || !serverRows?.length) {
      continue
    }
    const relayed = relayedServerAgentEntries(serverRows, server)
    if (relayed.length === 0) {
      continue
    }
    appendedByDesktop ??= new Map()
    let desktopAgents = appendedByDesktop.get(desktopHostId)
    if (!desktopAgents) {
      desktopAgents = [...info.agents]
      appendedByDesktop.set(desktopHostId, desktopAgents)
    }
    for (const entry of relayed) {
      desktopAgents.push(entry)
    }
  }
  if (!appendedByDesktop) {
    return worktreeInfo
  }
  const merged: Record<string, HostWorktreeInfo> = { ...worktreeInfo }
  for (const [desktopHostId, agents] of appendedByDesktop) {
    const info = worktreeInfo[desktopHostId]
    if (info) {
      merged[desktopHostId] = { ...info, agents }
    }
  }
  return merged
}
