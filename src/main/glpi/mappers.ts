import type {
  GlpiFollowup,
  GlpiServer,
  GlpiTicket,
  GlpiTicketStatus,
  GlpiTicketType,
  GlpiUser
} from '../../shared/types'

// GLPI ticket status codes (1..6) and type codes (1 incident, 2 request) are
// mapped to stable string keys here so the rest of the app never deals with
// raw integers.
export function mapGlpiStatus(value: number | string | null | undefined): GlpiTicketStatus {
  switch (Number(value)) {
    case 1:
      return 'new'
    case 2:
      return 'assigned'
    case 3:
      return 'planned'
    case 4:
      return 'pending'
    case 5:
      return 'solved'
    case 6:
      return 'closed'
    default:
      return 'new'
  }
}

export function glpiStatusToCode(status: GlpiTicketStatus): number {
  switch (status) {
    case 'new':
      return 1
    case 'assigned':
      return 2
    case 'planned':
      return 3
    case 'pending':
      return 4
    case 'solved':
      return 5
    case 'closed':
      return 6
  }
}

export function mapGlpiType(value: number | string | null | undefined): GlpiTicketType {
  return Number(value) === 2 ? 'request' : 'incident'
}

export function glpiTypeToCode(type: GlpiTicketType): number {
  return type === 'request' ? 2 : 1
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function glpiTicketUrl(baseUrl: string, id: number): string {
  return `${baseUrl}/front/ticket.form.php?id=${id}`
}

export type RawGlpiUser = {
  id?: number
  name?: string
  realname?: string | null
  firstname?: string | null
}

export function mapGlpiUser(raw: RawGlpiUser | null | undefined): GlpiUser | undefined {
  if (!raw || typeof raw.id !== 'number') {
    return undefined
  }
  const fullName = [raw.firstname, raw.realname]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .trim()
  return {
    id: raw.id,
    login: raw.name ?? String(raw.id),
    fullName: fullName || undefined
  }
}

export type RawGlpiTicket = {
  id?: number
  name?: string
  content?: string | null
  status?: number
  urgency?: number
  priority?: number
  type?: number
  itilcategories_id?: string | number | null
  date?: string | null
  date_creation?: string | null
  date_mod?: string | null
}

// Maps a full ticket from GET /Ticket/{id}?expand_dropdowns=true. Requester,
// assignees, and followup count are attached by the caller (they live on
// related endpoints rather than ticket columns).
export function mapGlpiTicketDetail(raw: RawGlpiTicket, server: GlpiServer): GlpiTicket {
  const id = numberOr(raw.id, 0)
  return {
    id,
    serverId: server.id,
    serverName: server.displayName,
    title: raw.name ?? '',
    content: typeof raw.content === 'string' ? raw.content : undefined,
    status: mapGlpiStatus(raw.status),
    urgency: numberOr(raw.urgency, 3),
    priority: numberOr(raw.priority, 3),
    type: mapGlpiType(raw.type),
    category: typeof raw.itilcategories_id === 'string' ? raw.itilcategories_id : undefined,
    assignees: [],
    url: glpiTicketUrl(server.baseUrl, id),
    followups: 0,
    createdAt: raw.date ?? raw.date_creation ?? '',
    updatedAt: raw.date_mod ?? ''
  }
}

// Maps a row from GET /search/Ticket (raw, no expand) where keys are the
// numeric search-option field ids forced via forcedisplay.
export function mapGlpiSearchRow(row: Record<string, unknown>, server: GlpiServer): GlpiTicket {
  const id = numberOr(row['2'], 0)
  return {
    id,
    serverId: server.id,
    serverName: server.displayName,
    title: typeof row['1'] === 'string' ? row['1'] : String(row['1'] ?? ''),
    status: mapGlpiStatus(row['12'] as number),
    urgency: numberOr(row['10'], 3),
    priority: numberOr(row['3'], 3),
    type: mapGlpiType(row['14'] as number | string | null | undefined),
    assignees: [],
    url: glpiTicketUrl(server.baseUrl, id),
    followups: numberOr(row['27'], 0),
    createdAt: typeof row['15'] === 'string' ? row['15'] : '',
    updatedAt: typeof row['19'] === 'string' ? row['19'] : ''
  }
}

export type RawGlpiFollowup = {
  id?: number
  content?: string | null
  date?: string | null
  users_id?: number
  is_private?: number | boolean
}

export function mapGlpiFollowup(raw: RawGlpiFollowup, user?: GlpiUser): GlpiFollowup {
  return {
    id: numberOr(raw.id, 0),
    content: typeof raw.content === 'string' ? raw.content : '',
    isPrivate: raw.is_private === 1 || raw.is_private === true,
    createdAt: raw.date ?? '',
    user
  }
}
