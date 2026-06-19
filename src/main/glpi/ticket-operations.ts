import type {
  GlpiCreateTicketArgs,
  GlpiCreateTicketResult,
  GlpiFollowup,
  GlpiMutationResult,
  GlpiServer,
  GlpiServerSelection,
  GlpiTicket,
  GlpiTicketFilter,
  GlpiTicketUpdate,
  GlpiWorkItemFilters
} from '../../shared/types'
import { getSelectedServers, getServerFile } from './server-store'
import {
  addGlpiFollowup,
  createGlpiTicket,
  getGlpiTicket,
  listGlpiFollowups,
  listGlpiTickets,
  updateGlpiTicket
} from './tickets'

// High-level GLPI ticket operations that resolve a stored server (or fan a
// read across every server for an 'all' selection) before delegating to the
// per-server primitives. The IPC and RPC layers call only these.

function resolveServer(serverId?: string | null): GlpiServer | null {
  const file = getServerFile()
  if (serverId) {
    return file.servers.find((server) => server.id === serverId) ?? null
  }
  return file.servers.find((server) => server.id === file.activeServerId) ?? file.servers[0] ?? null
}

export async function listGlpiWorkItems(
  selection: GlpiServerSelection | null | undefined,
  filter: GlpiTicketFilter,
  limit: number,
  filters?: GlpiWorkItemFilters
): Promise<GlpiTicket[]> {
  const servers = getSelectedServers(selection)
  const groups = await Promise.all(
    servers.map(async (server) => {
      try {
        return await listGlpiTickets(server, filter, limit, filters)
      } catch {
        // Why: one unreachable/un-decryptable server must not collapse reads
        // for the healthy ones under an 'all' selection.
        return []
      }
    })
  )
  return groups.flat()
}

export async function getGlpiTicketDetail(
  serverId: string | null | undefined,
  id: number
): Promise<GlpiTicket | null> {
  const server = resolveServer(serverId)
  return server ? getGlpiTicket(server, id) : null
}

export async function getGlpiTicketFollowups(
  serverId: string | null | undefined,
  id: number
): Promise<GlpiFollowup[]> {
  const server = resolveServer(serverId)
  return server ? listGlpiFollowups(server, id) : []
}

export async function addGlpiTicketFollowup(
  serverId: string | null | undefined,
  id: number,
  content: string
): Promise<GlpiMutationResult> {
  const server = resolveServer(serverId)
  if (!server) {
    return { ok: false, error: 'Not connected to GLPI.' }
  }
  return addGlpiFollowup(server, id, content)
}

export async function updateGlpiTicketDetail(
  serverId: string | null | undefined,
  id: number,
  updates: GlpiTicketUpdate
): Promise<GlpiMutationResult> {
  const server = resolveServer(serverId)
  if (!server) {
    return { ok: false, error: 'Not connected to GLPI.' }
  }
  return updateGlpiTicket(server, id, updates)
}

export async function createGlpiTicketOnServer(
  args: GlpiCreateTicketArgs
): Promise<GlpiCreateTicketResult> {
  const server = resolveServer(args.serverId)
  if (!server) {
    return { ok: false, error: 'Not connected to GLPI.' }
  }
  return createGlpiTicket(server, args)
}
