import { chatterHtmlToMarkdown, markdownToChatterHtml } from './chatter-html-markdown'
import { acquire, executeKw, getClients, release, type OdooClientForInstance } from './client'
import {
  base64ImageDataUri,
  mapCommentAttachments,
  mapMentionSuggestion,
  readIdList,
  readMany2One,
  readString,
  toIsoDate,
  type OdooRecord
} from './ticket-mappers'
import { describeOdooAttachmentUploadOverLimit } from '../../shared/odoo-attachment-upload-limit'
import type {
  OdooAttachmentUpload,
  OdooComment,
  OdooInstanceSelection,
  OdooMentionSuggestion,
  OdooMutationResult
} from '../../shared/odoo-types'

/**
 * Caps one chatter read: an unbounded one transfers every body plus a base64
 * avatar per distinct author on each refresh of a long-lived ticket.
 */
export const ODOO_TICKET_COMMENT_PAGE_SIZE = 200

/** Resolves the session user's `res.partner` id, used to gate message edits and to attribute mentions. */
async function resolveSessionPartnerId(client: OdooClientForInstance): Promise<number | null> {
  const rows = await executeKw<OdooRecord[]>(client, 'res.users', 'read', [[client.instance.uid]], {
    fields: ['partner_id']
  })
  return readMany2One(rows[0]?.partner_id)?.id ?? null
}

/** Posts a markdown `body` to the ticket chatter as a message or internal note. */
export async function addTicketComment(
  id: number,
  body: string,
  isNote?: boolean,
  instanceId?: OdooInstanceSelection | null,
  mentionPartnerIds?: number[],
  attachmentIds?: number[]
): Promise<OdooMutationResult> {
  const client = getClients(instanceId)[0]
  if (!client) {
    return { ok: false, error: 'Not connected to Odoo.' }
  }
  await acquire()
  try {
    const kwargs: OdooRecord = {
      // mt_note posts an internal "Log note" (no follower notification); mt_comment
      // notifies followers like Odoo's "Send message". body_is_html keeps the HTML
      // intact: message_post escapes plain strings, and RPC cannot pass a Markup.
      body: markdownToChatterHtml(body),
      body_is_html: true,
      message_type: 'comment',
      subtype_xmlid: isNote ? 'mail.mt_note' : 'mail.mt_comment'
    }
    if (mentionPartnerIds && mentionPartnerIds.length > 0) {
      // Notifying the mentioned partners is what actually delivers the @mention.
      kwargs.partner_ids = mentionPartnerIds
    }
    if (attachmentIds && attachmentIds.length > 0) {
      kwargs.attachment_ids = attachmentIds
    }
    await executeKw<number>(client, 'project.task', 'message_post', [[id]], kwargs)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not post comment.' }
  } finally {
    release()
  }
}

/** Edits a chatter message's body; refuses when the session user did not author it. */
export async function updateTicketComment(
  messageId: number,
  body: string,
  instanceId?: OdooInstanceSelection | null
): Promise<OdooMutationResult> {
  const client = getClients(instanceId)[0]
  if (!client) {
    return { ok: false, error: 'Not connected to Odoo.' }
  }
  await acquire()
  try {
    const rows = await executeKw<OdooRecord[]>(client, 'mail.message', 'read', [[messageId]], {
      fields: ['author_id']
    })
    const message = rows[0]
    if (!message) {
      return { ok: false, error: 'Message not found.' }
    }
    const author = readMany2One(message.author_id)
    const sessionPartnerId = await resolveSessionPartnerId(client)
    if (!author || sessionPartnerId === null || author.id !== sessionPartnerId) {
      return { ok: false, error: 'You can only edit your own messages.' }
    }
    // Why: mail.message.write() is the plain ORM write(self, vals) — the vals
    // dict must ride in `args`, not `kwargs`, or Odoo calls write(body=...) and
    // raises "write() got an unexpected keyword argument 'body'".
    await executeKw<number>(client, 'mail.message', 'write', [
      [messageId],
      { body: markdownToChatterHtml(body) }
    ])
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not update comment.'
    }
  } finally {
    release()
  }
}

/**
 * Suggests `res.partner` ids for the composer's @mention autocomplete.
 *
 * Why partner ids, not user ids: `message_post`'s `partner_ids` kwarg — the
 * one that actually delivers the notification — expects partners, not users.
 */
export async function searchMentionCandidates(
  ticketId: number,
  query: string,
  instanceId?: OdooInstanceSelection | null
): Promise<OdooMentionSuggestion[]> {
  const client = getClients(instanceId)[0]
  if (!client) {
    return []
  }
  await acquire()
  try {
    const trimmed = query.trim()
    // Empty query: surface the ticket's current assignees first, since they're
    // the most likely people to @mention; fall back to active users otherwise.
    let assigneeIds: number[] = []
    if (!trimmed) {
      const taskRows = await executeKw<OdooRecord[]>(client, 'project.task', 'read', [[ticketId]], {
        fields: ['user_ids']
      })
      assigneeIds = readIdList(taskRows[0]?.user_ids).slice(0, 10)
    }
    const domain: unknown[] =
      assigneeIds.length > 0
        ? [
            ['id', 'in', assigneeIds],
            ['active', '=', true]
          ]
        : trimmed
          ? [
              ['name', 'ilike', trimmed],
              ['active', '=', true],
              // `share = false` keeps portal/public contacts out of mentions.
              ['share', '=', false]
            ]
          : [
              ['active', '=', true],
              ['share', '=', false]
            ]

    const users = await executeKw<OdooRecord[]>(client, 'res.users', 'search_read', [domain], {
      fields: ['name', 'login', 'partner_id'],
      limit: 10,
      order: 'name asc'
    })

    const partnerIds = users.flatMap((user) => {
      const partner = readMany2One(user.partner_id)
      return partner ? [partner.id] : []
    })
    const partners =
      partnerIds.length > 0
        ? await executeKw<OdooRecord[]>(client, 'res.partner', 'read', [partnerIds], {
            fields: ['avatar_128']
          })
        : []
    const avatarById = new Map<number, string>()
    for (const partner of partners) {
      const uri = base64ImageDataUri(partner.avatar_128)
      if (uri) {
        avatarById.set(partner.id as number, uri)
      }
    }

    return users.flatMap((user) => {
      const suggestion = mapMentionSuggestion(user, avatarById)
      return suggestion ? [suggestion] : []
    })
  } finally {
    release()
  }
}

/** Creates `ir.attachment` records on a ticket, ahead of attaching them to a chatter message. */
export async function uploadTicketAttachments(
  ticketId: number,
  files: OdooAttachmentUpload[],
  instanceId?: OdooInstanceSelection | null
): Promise<{ ok: true; ids: number[] } | { ok: false; error: string }> {
  const client = getClients(instanceId)[0]
  if (!client) {
    return { ok: false, error: 'Not connected to Odoo.' }
  }
  if (files.length === 0) {
    return { ok: true, ids: [] }
  }
  const overLimitError = describeOdooAttachmentUploadOverLimit(files)
  if (overLimitError) {
    return { ok: false, error: overLimitError }
  }
  await acquire()
  try {
    const valsList = files.map((file) => ({
      name: file.name,
      datas: file.data,
      mimetype: file.mimetype,
      res_model: 'project.task',
      res_id: ticketId
    }))
    // Odoo's create() accepts a list of value dicts and returns a matching list
    // of ids — one round trip for the whole batch instead of one per file.
    const ids = await executeKw<number[]>(client, 'ir.attachment', 'create', [valsList])
    return { ok: true, ids }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not upload attachments.'
    }
  } finally {
    release()
  }
}

export async function getTicketComments(
  id: number,
  instanceId?: OdooInstanceSelection | null
): Promise<OdooComment[]> {
  const client = getClients(instanceId)[0]
  if (!client) {
    return []
  }
  await acquire()
  try {
    const rows = await executeKw<OdooRecord[]>(
      client,
      'mail.message',
      'search_read',
      [
        [
          ['model', '=', 'project.task'],
          ['res_id', '=', id],
          // Odoo logs field changes as `notification` messages; only real
          // comments and inbound email belong in a ticket discussion.
          ['message_type', 'in', ['comment', 'email']]
        ]
      ],
      {
        fields: ['id', 'body', 'date', 'author_id', 'subtype_id', 'attachment_ids'],
        // Newest-first so the cap keeps the recent page; reversed back to
        // ascending below, which is the order the chatter panel renders.
        order: 'date desc',
        limit: ODOO_TICKET_COMMENT_PAGE_SIZE
      }
    )
    rows.reverse()

    const distinctIds = (pick: (row: OdooRecord) => unknown): number[] => [
      ...new Set(
        rows.flatMap((row) => {
          const ref = readMany2One(pick(row))
          return ref ? [ref.id] : []
        })
      )
    ]

    const attachmentIds = [...new Set(rows.flatMap((row) => readIdList(row.attachment_ids)))]

    // A "note" is any message whose subtype is internal; resolve the internal
    // flag, author avatars, and attachment metadata in one batch read each to
    // avoid per-row round trips.
    const subtypeIds = distinctIds((row) => row.subtype_id)
    const authorIds = distinctIds((row) => row.author_id)
    const [subtypes, partners, attachments, sessionPartnerId] = await Promise.all([
      subtypeIds.length > 0
        ? executeKw<OdooRecord[]>(client, 'mail.message.subtype', 'read', [subtypeIds], {
            fields: ['internal']
          })
        : Promise.resolve([]),
      authorIds.length > 0
        ? executeKw<OdooRecord[]>(client, 'res.partner', 'read', [authorIds], {
            fields: ['avatar_128']
          })
        : Promise.resolve([]),
      attachmentIds.length > 0
        ? executeKw<OdooRecord[]>(client, 'ir.attachment', 'read', [attachmentIds], {
            fields: ['name', 'mimetype']
          })
        : Promise.resolve([]),
      resolveSessionPartnerId(client)
    ])
    const internalById = new Map(subtypes.map((s) => [s.id as number, s.internal === true]))
    const avatarById = new Map<number, string>()
    for (const partner of partners) {
      const uri = base64ImageDataUri(partner.avatar_128)
      if (uri) {
        avatarById.set(partner.id as number, uri)
      }
    }
    const attachmentsById = new Map(
      attachments.map((a) => [
        a.id as number,
        { name: readString(a.name), mimetype: readString(a.mimetype) }
      ])
    )

    return rows.map((row) => {
      const author = readMany2One(row.author_id)
      const subtype = readMany2One(row.subtype_id)
      const rowAttachmentIds = readIdList(row.attachment_ids)
      return {
        id: row.id as number,
        body: chatterHtmlToMarkdown(readString(row.body) ?? ''),
        createdAt: toIsoDate(row.date),
        author: author
          ? { id: author.id, displayName: author.name, avatarUrl: avatarById.get(author.id) }
          : undefined,
        isNote: subtype ? (internalById.get(subtype.id) ?? false) : false,
        attachments:
          rowAttachmentIds.length > 0
            ? mapCommentAttachments(rowAttachmentIds, attachmentsById, client.instance.serverUrl)
            : undefined,
        canEdit: author !== null && sessionPartnerId !== null && author.id === sessionPartnerId
      }
    })
  } finally {
    release()
  }
}
