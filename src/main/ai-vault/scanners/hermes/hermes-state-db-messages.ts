import type { AiVaultSessionPreviewMessage } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type SyncDatabase from '../../../sqlite/sync-database'
import { timestampIso } from '../../parsing/session-scanner-accumulator'
import { parseJsonObject } from '../../parsing/session-json-object'
import { asRecord } from '../../parsing/session-record-fields'
import { decodeSessionMessage } from '../../transcripts/session-decoded-message'
import type { HermesConversation } from './hermes-state-db-conversations'
import type { HermesSchema } from './hermes-state-db-schema'

// Hermes marks JSON-encoded (multimodal) content with this prefix (hermes_state.py _CONTENT_JSON_PREFIX).
const CONTENT_JSON_PREFIX = '\u0000json:'
// Previews and titles need only the start of a message; a pasted log can be megabytes.
const PREVIEW_CONTENT_BYTES = 16 * 1024
const MULTIMODAL = `substr(m.content, 1, 6) = char(0) || 'json:'`

/** What the display projection needs of a row: no bodies, so a long store costs no payload memory. */
export type MessageIdentity = {
  id: number
  role: string
  timestamp: number
  active: number
  compacted: number
  display_order: number | null
  message_uid: string | null
  session_id: string
}

export type MessageRow = {
  id: number
  role: string
  content: string | null
  content_truncated: number
  tool_calls: string | null
  reasoning: string | null
  timestamp: number
}

function modelOnlyClause(schema: HermesSchema): string {
  return schema.messages.has('display_metadata')
    ? `AND (m.display_metadata IS NULL OR instr(m.display_metadata, 'model_only') = 0 OR COALESCE(json_extract(CASE WHEN json_valid(m.display_metadata) THEN m.display_metadata ELSE '{}' END, '$.model_only'), 0) = 0)`
    : ''
}

/** Every user, assistant and tool row of the segments in order, rewound ones included: a rewound
 *  newest copy hides the message (model-only rows never paint). */
export function readMessageIdentities(
  db: SyncDatabase,
  schema: HermesSchema,
  conversation: HermesConversation
): MessageIdentity[] {
  const has = (column: string) => schema.messages.has(column)
  const statement =
    db.prepare(`SELECT m.id, m.session_id, m.role, m.timestamp, ${has('active') ? 'm.active' : '1 AS active'},
      ${has('compacted') ? 'm.compacted' : '0 AS compacted'},
      ${has('display_order') ? 'm.display_order' : 'NULL AS display_order'},
      ${has('message_uid') ? 'm.message_uid' : 'NULL AS message_uid'}
    FROM messages m
    WHERE m.session_id = ? AND m.role IN ('user', 'assistant', 'tool') ${modelOnlyClause(schema)}
    ORDER BY m.id`)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query projects every MessageIdentity column.
  return conversation.segments.flatMap((segment) => statement.all(segment.id) as MessageIdentity[])
}

function shownCopy(current: MessageIdentity | null, next: MessageIdentity): MessageIdentity {
  if (!current) {
    return next
  }
  // A compacted tool result paints as its archived original, never a later shortened copy
  // (hermes_state_compaction_display.not_a_later_tool_copy_sql).
  if (
    current.role === 'tool' &&
    current.active === 0 &&
    current.compacted === 1 &&
    next.active === 1 &&
    (next.display_order ?? 0) > (current.display_order ?? 0)
  ) {
    return current
  }
  return next.active >= current.active ? next : current
}

/** Hermes' display projection (hermes_state_messages.py `_dedupe_display_generations`): one message
 *  per display slot or message_uid, painted as its live copy, and hidden when its newest copy was
 *  rewound, so a rewind in a compression continuation never brings back the parent's copy. */
export function displayedMessages(identities: readonly MessageIdentity[]): MessageIdentity[] {
  const groups: { shown: MessageIdentity | null; newestRemoved: boolean }[] = []
  const groupOf = new Map<string, number>()
  for (const row of identities) {
    const removed = row.active === 0 && row.compacted === 0
    const keys = [
      ...(row.display_order !== null ? [`slot:${row.session_id}:${row.display_order}`] : []),
      ...(row.message_uid ? [`uid:${row.message_uid}`] : [])
    ]
    // Stores from before display identities: a carried copy keeps its role and timestamp.
    if (keys.length === 0) {
      keys.push(`copy:${row.role}:${row.timestamp}`)
    }
    let index = keys.map((key) => groupOf.get(key)).find((found) => found !== undefined)
    if (index === undefined) {
      index = groups.length
      groups.push({ shown: null, newestRemoved: false })
    }
    keys.forEach((key) => groupOf.set(key, index))
    const group = groups[index]
    group.newestRemoved = removed
    if (!removed) {
      group.shown = shownCopy(group.shown, row)
    }
  }
  return groups.flatMap((group) => (group.shown && !group.newestRemoved ? [group.shown] : []))
}

function bodyColumns(schema: HermesSchema, full: boolean, tools: boolean): string {
  const has = (column: string) => schema.messages.has(column)
  const reasoning = ['reasoning_content', 'reasoning'].filter(has).map((column) => `m.${column}`)
  return [
    'm.id',
    'm.role',
    'm.timestamp',
    // Multimodal content is JSON whose text a cut would lose; only plain text is cut for previews.
    full
      ? 'm.content'
      : `CASE WHEN ${MULTIMODAL} THEN m.content ELSE CAST(substr(CAST(m.content AS BLOB), 1, ${PREVIEW_CONTENT_BYTES}) AS TEXT) END AS content`,
    full
      ? '0 AS content_truncated'
      : `NOT (${MULTIMODAL}) AND length(CAST(m.content AS BLOB)) > ${PREVIEW_CONTENT_BYTES} AS content_truncated`,
    tools && has('tool_calls') ? 'm.tool_calls' : 'NULL AS tool_calls',
    `${reasoning.length > 1 ? `COALESCE(${reasoning.join(', ')})` : (reasoning[0] ?? 'NULL')} AS reasoning`
  ].join(', ')
}

const BODY_BATCH = 200

/** Bodies of the chosen rows, in their order, a batch at a time so a capture never holds them all.
 *  `full: false` reads only each message's opening bytes. */
export function* readMessageBodies(
  db: SyncDatabase,
  schema: HermesSchema,
  rows: readonly MessageIdentity[],
  options: { full: boolean; tools: boolean }
): Generator<MessageRow> {
  for (let start = 0; start < rows.length; start += BODY_BATCH) {
    const batch = rows.slice(start, start + BODY_BATCH)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bodyColumns projects every MessageRow column.
    const found = db
      .prepare(
        `SELECT ${bodyColumns(schema, options.full, options.tools)} FROM messages m
         WHERE m.id IN (${batch.map(() => '?').join(',')})`
      )
      .all(...batch.map((row) => row.id)) as MessageRow[]
    const byId = new Map(found.map((row) => [row.id, row]))
    for (const row of batch) {
      const body = byId.get(row.id)
      if (body) {
        yield body
      }
    }
  }
}

function decodedContent(row: MessageRow): unknown {
  const { content } = row
  if (!content?.startsWith(CONTENT_JSON_PREFIX)) {
    return content
  }
  try {
    const parts: unknown = JSON.parse(content.slice(CONTENT_JSON_PREFIX.length))
    return parts
  } catch {
    // A cut multimodal preview is not JSON any more; it has no text to show.
    return row.content_truncated ? null : content
  }
}

function toolCallBlocks(toolCalls: string | null): unknown[] {
  if (!toolCalls) {
    return []
  }
  let calls: unknown
  try {
    calls = JSON.parse(toolCalls)
  } catch {
    return []
  }
  if (!Array.isArray(calls)) {
    return []
  }
  return calls.flatMap((call) => {
    const fn = asRecord(asRecord(call)?.function)
    if (!fn) {
      return []
    }
    const input = typeof fn.arguments === 'string' ? parseJsonObject(fn.arguments) : null
    return [{ type: 'tool_use', name: fn.name, input: input ?? fn.arguments }]
  })
}

function messageRole(role: string): AiVaultSessionPreviewMessage['role'] {
  return role === 'user' || role === 'assistant' || role === 'tool' || role === 'system'
    ? role
    : 'unknown'
}

export function decodeHermesMessage(row: MessageRow, includeTools: boolean) {
  const content = decodedContent(row)
  const role = messageRole(row.role)
  if (role === 'tool') {
    return decodeSessionMessage(
      'tool',
      [{ type: 'tool_result', content }],
      timestampIso(row.timestamp),
      { includeTools }
    )
  }
  const blocks: unknown[] = []
  if (row.reasoning && role === 'assistant') {
    blocks.push({ type: 'reasoning', text: row.reasoning })
  }
  blocks.push(...(Array.isArray(content) ? content : content ? [content] : []))
  blocks.push(...toolCallBlocks(row.tool_calls))
  return decodeSessionMessage(role, blocks, timestampIso(row.timestamp), { includeTools })
}
