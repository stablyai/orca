import { chatterHtmlToMarkdown } from './chatter-html-markdown'
import { executeKw, type OdooClientForInstance } from './json-rpc'
import { ODOO_PRIORITIES, ODOO_TICKET_STATES } from '../../shared/odoo-types'
import type {
  OdooCommentAttachment,
  OdooMentionSuggestion,
  OdooPriority,
  OdooStage,
  OdooTag,
  OdooTicket,
  OdooTicketState,
  OdooUser
} from '../../shared/odoo-types'
export type OdooRecord = Record<string, unknown>

export const TICKET_FIELDS = [
  'id',
  'name',
  'description',
  'priority',
  'state',
  'stage_id',
  'project_id',
  'partner_id',
  'user_ids',
  'tag_ids',
  'create_uid',
  'create_date',
  'write_date',
  'date_deadline'
]

/** Odoo many2one reads back as `[id, display_name]`, or `false` when unset. */
export function readMany2One(value: unknown): { id: number; name: string } | null {
  if (!Array.isArray(value) || typeof value[0] !== 'number') {
    return null
  }
  return { id: value[0], name: typeof value[1] === 'string' ? value[1] : String(value[0]) }
}

export function readIdList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : []
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Wraps an Odoo base64 image field (`avatar_128`, …) as a data URI. Odoo serves
 * generated placeholders as SVG, so the container is sniffed from the base64
 * prefix — mislabeling an SVG as PNG makes the browser refuse to render it.
 */
export function base64ImageDataUri(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const mime =
    value.startsWith('PHN2') || value.startsWith('PD94')
      ? 'image/svg+xml'
      : value.startsWith('/9j/')
        ? 'image/jpeg'
        : value.startsWith('R0lGOD')
          ? 'image/gif'
          : 'image/png'
  return `data:${mime};base64,${value}`
}

function readPriority(value: unknown): OdooPriority {
  return ODOO_PRIORITIES.find((priority) => priority === value) ?? '0'
}

function readState(value: unknown): OdooTicketState {
  return ODOO_TICKET_STATES.find((state) => state === value) ?? '01_in_progress'
}

/**
 * Odoo datetimes are naive UTC strings (`YYYY-MM-DD HH:MM:SS`); Date fields such
 * as `date_deadline` are date-only, which needs a time part to stay RFC 3339.
 */
export function toIsoDate(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return new Date(0).toISOString()
  }
  const normalized = value.includes('T')
    ? value
    : value.includes(' ')
      ? value.replace(' ', 'T')
      : `${value}T00:00:00`
  return normalized.endsWith('Z') ? normalized : `${normalized}Z`
}

export function ticketUrl(serverUrl: string, id: number): string {
  // `all-tasks` is registered as a project-agnostic action path, so it also
  // resolves tickets that carry no project.
  return `${serverUrl}/odoo/all-tasks/${id}`
}

export function ticketRef(id: number): string {
  return `#${id}`
}

export function mapUser(raw: OdooRecord): OdooUser {
  return {
    id: raw.id as number,
    displayName: readString(raw.name) ?? String(raw.id),
    login: readString(raw.login),
    avatarUrl: base64ImageDataUri(raw.avatar_128)
  }
}

/**
 * Maps a `res.users` row to a chatter mention candidate.
 *
 * The label is the user's own `name`, not the `partner_id` many2one's
 * display_name: Odoo renders a company-scoped partner as "Acme, Marc Demo", and
 * the composer only keeps a picked mention while its literal `@<name>` is still
 * in the draft — so trimming the company prefix would silently drop the
 * `partner_ids` entry with no feedback.
 */
export function mapMentionSuggestion(
  raw: OdooRecord,
  avatarById: ReadonlyMap<number, string>
): OdooMentionSuggestion | null {
  const partner = readMany2One(raw.partner_id)
  if (!partner) {
    return null
  }
  return {
    id: partner.id,
    name: readString(raw.name) ?? partner.name,
    login: readString(raw.login),
    avatarUrl: avatarById.get(partner.id)
  }
}

/**
 * Maps one message's `attachment_ids` to full attachment records.
 *
 * Why a lookup map: comments are read in one batch, and `ir.attachment` is
 * read once for every distinct id across all of them — resolving per message
 * would mean one round trip per comment.
 */
export function mapCommentAttachments(
  ids: number[],
  attachmentsById: Map<number, { name?: string; mimetype?: string }>,
  serverUrl: string
): OdooCommentAttachment[] {
  return ids.flatMap((id) => {
    const attachment = attachmentsById.get(id)
    if (!attachment) {
      return []
    }
    return [
      {
        id,
        name: attachment.name ?? String(id),
        mimetype: attachment.mimetype,
        url: `${serverUrl}/web/content/${id}?download=true`
      }
    ]
  })
}

export function mapTag(raw: OdooRecord): OdooTag {
  return {
    id: raw.id as number,
    name: readString(raw.name) ?? String(raw.id),
    color: typeof raw.color === 'number' ? raw.color : undefined
  }
}

export function mapStage(raw: OdooRecord): OdooStage {
  return {
    id: raw.id as number,
    name: readString(raw.name) ?? String(raw.id),
    sequence: typeof raw.sequence === 'number' ? raw.sequence : 0,
    fold: raw.fold === true,
    color: typeof raw.color === 'number' ? raw.color : undefined
  }
}

export type Lookups = {
  usersById: Map<number, OdooUser>
  tagsById: Map<number, OdooTag>
  stagesById: Map<number, OdooStage>
}

/**
 * Resolves the many2many labels a ticket list needs.
 *
 * Why: search_read returns only ids for user_ids/tag_ids, so names would
 * otherwise cost one round trip per ticket.
 */
export async function loadLookups(
  client: OdooClientForInstance,
  rows: OdooRecord[]
): Promise<Lookups> {
  const userIds = new Set<number>()
  const tagIds = new Set<number>()
  const stageIds = new Set<number>()
  for (const row of rows) {
    for (const id of readIdList(row.user_ids)) {
      userIds.add(id)
    }
    for (const id of readIdList(row.tag_ids)) {
      tagIds.add(id)
    }
    const stage = readMany2One(row.stage_id)
    if (stage) {
      stageIds.add(stage.id)
    }
  }

  const [users, tags, stages] = await Promise.all([
    userIds.size > 0
      ? executeKw<OdooRecord[]>(client, 'res.users', 'read', [[...userIds]], {
          fields: ['name', 'login', 'avatar_128']
        })
      : Promise.resolve([]),
    tagIds.size > 0
      ? executeKw<OdooRecord[]>(client, 'project.tags', 'read', [[...tagIds]], {
          fields: ['name', 'color']
        })
      : Promise.resolve([]),
    stageIds.size > 0
      ? executeKw<OdooRecord[]>(client, 'project.task.type', 'read', [[...stageIds]], {
          fields: ['name', 'sequence', 'fold', 'color']
        })
      : Promise.resolve([])
  ])

  return {
    usersById: new Map(users.map((user) => [user.id as number, mapUser(user)])),
    tagsById: new Map(tags.map((tag) => [tag.id as number, mapTag(tag)])),
    stagesById: new Map(stages.map((stage) => [stage.id as number, mapStage(stage)]))
  }
}

export function mapTicket(
  client: OdooClientForInstance,
  raw: OdooRecord,
  lookups: Lookups
): OdooTicket {
  const { instance } = client
  const id = typeof raw.id === 'number' ? raw.id : 0
  const project = readMany2One(raw.project_id)
  const customer = readMany2One(raw.partner_id)
  const stageRef = readMany2One(raw.stage_id)
  const creator = readMany2One(raw.create_uid)
  const description = readString(raw.description)

  return {
    id,
    ref: ticketRef(id),
    instanceId: instance.id,
    instanceName: instance.displayName,
    title: readString(raw.name) ?? ticketRef(id),
    description: description ? chatterHtmlToMarkdown(description) : undefined,
    url: ticketUrl(instance.serverUrl, id),
    project: project
      ? {
          id: project.id,
          name: project.name,
          instanceId: instance.id,
          instanceName: instance.displayName
        }
      : undefined,
    customer: customer ? { id: customer.id, name: customer.name } : undefined,
    stage: stageRef
      ? (lookups.stagesById.get(stageRef.id) ?? {
          id: stageRef.id,
          name: stageRef.name,
          sequence: 0,
          fold: false
        })
      : undefined,
    state: readState(raw.state),
    priority: readPriority(raw.priority),
    tags: readIdList(raw.tag_ids).flatMap((tagId) => {
      const tag = lookups.tagsById.get(tagId)
      return tag ? [tag] : []
    }),
    assignees: readIdList(raw.user_ids).flatMap((userId) => {
      const user = lookups.usersById.get(userId)
      return user ? [user] : []
    }),
    creator: creator ? { id: creator.id, displayName: creator.name } : undefined,
    deadline: typeof raw.date_deadline === 'string' ? toIsoDate(raw.date_deadline) : undefined,
    createdAt: toIsoDate(raw.create_date),
    updatedAt: toIsoDate(raw.write_date)
  }
}
