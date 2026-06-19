import type {
  GlpiCreateTicketArgs,
  GlpiCreateTicketResult,
  GlpiFollowup,
  GlpiMutationResult,
  GlpiServer,
  GlpiTicket,
  GlpiTicketFilter,
  GlpiTicketUpdate,
  GlpiUser,
  GlpiWorkItemFilters
} from '../../shared/types'
import { acquire, glpiServerRequest, release, type GlpiFullSession } from './session'
import {
  glpiStatusToCode,
  glpiTicketUrl,
  glpiTypeToCode,
  mapGlpiFollowup,
  mapGlpiSearchRow,
  mapGlpiTicketDetail,
  mapGlpiUser,
  type RawGlpiFollowup,
  type RawGlpiTicket,
  type RawGlpiUser
} from './mappers'
import { buildSearchQuery, filterCriteria, workItemFilterCriteria } from './ticket-search-query'
import { inlineGlpiContentImages } from './glpi-content-images'

async function resolveViewerId(server: GlpiServer): Promise<number> {
  const data = await glpiServerRequest<{ session?: Partial<GlpiFullSession> }>(
    server,
    '/getFullSession'
  )
  const id = data.session?.glpiID
  return typeof id === 'number' ? id : 0
}

export async function listGlpiTickets(
  server: GlpiServer,
  filter: GlpiTicketFilter,
  limit: number,
  filters?: GlpiWorkItemFilters
): Promise<GlpiTicket[]> {
  await acquire()
  try {
    const viewerId =
      filter === 'assigned' || filter === 'created' ? await resolveViewerId(server) : 0
    const criteria = filterCriteria(filter, viewerId)
    if (filters) {
      criteria.push(...workItemFilterCriteria(filters))
    }
    const query = buildSearchQuery(criteria, limit)
    const result = await glpiServerRequest<{ data?: Record<string, unknown>[] }>(
      server,
      `/search/Ticket?${query}`
    )
    const rows = Array.isArray(result.data) ? result.data : []
    return rows.map((row) => mapGlpiSearchRow(row, server))
  } finally {
    release()
  }
}

// Ticket_User links carry a type: 1 requester, 2 assigned technician, 3 watcher.
type RawTicketUser = { users_id?: number; type?: number }

async function resolveUsers(server: GlpiServer, ids: number[]): Promise<Map<number, GlpiUser>> {
  const unique = [...new Set(ids.filter((id) => id > 0))]
  const entries = await Promise.all(
    unique.map(async (id) => {
      try {
        const raw = await glpiServerRequest<RawGlpiUser>(server, `/User/${id}`)
        const user = mapGlpiUser(raw)
        return user ? ([id, user] as const) : null
      } catch {
        return null
      }
    })
  )
  return new Map(entries.filter((entry): entry is readonly [number, GlpiUser] => entry !== null))
}

export async function getGlpiTicket(server: GlpiServer, id: number): Promise<GlpiTicket | null> {
  await acquire()
  try {
    // Why: request raw values (expand_dropdowns off) so status/urgency/priority/
    // type stay numeric — expanding them returns localized strings that break the
    // int→key mapping. The FK category name is resolved separately below.
    const raw = await glpiServerRequest<RawGlpiTicket>(server, `/Ticket/${id}?expand_dropdowns=0`)
    if (typeof raw.id !== 'number') {
      return null
    }
    const ticket = mapGlpiTicketDetail(raw, server)
    // Why: with expand_dropdowns off, GLPI returns itilcategories_id as a numeric
    // string (e.g. "6"), so coerce strings too before the FK lookup.
    const categoryId =
      typeof raw.itilcategories_id === 'number'
        ? raw.itilcategories_id
        : typeof raw.itilcategories_id === 'string'
          ? Number(raw.itilcategories_id)
          : 0
    if (Number.isInteger(categoryId) && categoryId > 0) {
      try {
        const category = await glpiServerRequest<{ completename?: string; name?: string }>(
          server,
          `/ITILCategory/${categoryId}`
        )
        ticket.category = category.completename ?? category.name ?? undefined
      } catch {
        // Category is optional context — ignore lookup failures.
      }
    }
    // Why: requester/assignee enrichment is optional context — a failure here
    // must not drop the already-loaded ticket detail, so swallow and continue.
    try {
      const links = await glpiServerRequest<RawTicketUser[]>(server, `/Ticket/${id}/Ticket_User`)
      const userLinks = Array.isArray(links) ? links : []
      const users = await resolveUsers(
        server,
        userLinks.map((link) => link.users_id ?? 0)
      )
      ticket.requester = userLinks
        .filter((link) => link.type === 1)
        .map((link) => users.get(link.users_id ?? 0))
        .find((user): user is GlpiUser => user !== undefined)
      ticket.assignees = userLinks
        .filter((link) => link.type === 2)
        .map((link) => users.get(link.users_id ?? 0))
        .filter((user): user is GlpiUser => user !== undefined)
    } catch {
      ticket.requester = undefined
      ticket.assignees = []
    }
    if (ticket.content) {
      ticket.content = await inlineGlpiContentImages(server, ticket.content)
    }
    return ticket
  } finally {
    release()
  }
}

export async function listGlpiFollowups(server: GlpiServer, id: number): Promise<GlpiFollowup[]> {
  await acquire()
  try {
    const raw = await glpiServerRequest<RawGlpiFollowup[]>(server, `/Ticket/${id}/ITILFollowup`)
    const followups = Array.isArray(raw) ? raw : []
    const users = await resolveUsers(
      server,
      followups.map((followup) => followup.users_id ?? 0)
    )
    const mapped = await Promise.all(
      followups.map(async (followup) => {
        const entry = mapGlpiFollowup(followup, users.get(followup.users_id ?? 0))
        entry.content = await inlineGlpiContentImages(server, entry.content)
        return entry
      })
    )
    return mapped.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } finally {
    release()
  }
}

export async function addGlpiFollowup(
  server: GlpiServer,
  id: number,
  content: string
): Promise<GlpiMutationResult> {
  await acquire()
  try {
    await glpiServerRequest(server, '/ITILFollowup', {
      method: 'POST',
      body: JSON.stringify({ input: { itemtype: 'Ticket', items_id: id, content } })
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add followup.' }
  } finally {
    release()
  }
}

export async function updateGlpiTicket(
  server: GlpiServer,
  id: number,
  updates: GlpiTicketUpdate
): Promise<GlpiMutationResult> {
  const input: Record<string, unknown> = {}
  if (updates.title !== undefined) {
    input.name = updates.title
  }
  if (updates.content !== undefined) {
    input.content = updates.content
  }
  if (updates.status !== undefined) {
    input.status = glpiStatusToCode(updates.status)
  }
  if (Object.keys(input).length === 0) {
    return { ok: true }
  }
  await acquire()
  try {
    await glpiServerRequest(server, `/Ticket/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ input })
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to update ticket.' }
  } finally {
    release()
  }
}

export async function createGlpiTicket(
  server: GlpiServer,
  args: GlpiCreateTicketArgs
): Promise<GlpiCreateTicketResult> {
  await acquire()
  try {
    const input: Record<string, unknown> = {
      name: args.title,
      content: args.content ?? '',
      type: glpiTypeToCode(args.type ?? 'incident')
    }
    if (typeof args.urgency === 'number') {
      input.urgency = args.urgency
    }
    const created = await glpiServerRequest<{ id?: number } | { id?: number }[]>(
      server,
      '/Ticket',
      {
        method: 'POST',
        body: JSON.stringify({ input })
      }
    )
    const record = Array.isArray(created) ? created[0] : created
    const newId = typeof record?.id === 'number' ? record.id : 0
    if (!newId) {
      return { ok: false, error: 'GLPI did not return the new ticket id.' }
    }
    return { ok: true, id: newId, url: glpiTicketUrl(server.baseUrl, newId) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create ticket.' }
  } finally {
    release()
  }
}
