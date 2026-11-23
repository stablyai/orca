import * as z from 'zod'
import {
  BotGroupMessageImageSchema,
  BotGroupMessageSchema,
  BotGroupRemoteAskSchema,
  BotGroupRemoteMemberSchema,
  BotGroupSchema,
  LegacyBotGroupSchema
} from '../../shared/bots/bot-group-schema'

// What this build's rewrite of a group or post keeps from the stored record: what a newer build
// stored that this build's schema strips on reading, at any depth this build's schema describes.

/**
 * First in every record this build rewrites: it kept what it doesn't know. A rewrite that lacks
 * it is from an older release (`bot-group-record-keys`). One exception, from before the marker:
 * a rewrite that leaves out `images` or `remoteAsks` keeps the stored list, so this build clears
 * either by writing an empty list. That also keeps a list this build couldn't read.
 */
export const KEEPS_KEYS = 'keepsUnknownKeys'

export type Json = Record<string, unknown>

export const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** How the entries of each list of records are matched across writes. */
const ENTRY_IDS = new Map<z.ZodType, readonly string[]>([
  [BotGroupMessageSchema.shape.turns.element, ['operationId']],
  [BotGroupRemoteAskSchema, ['requestId']],
  [BotGroupMessageImageSchema, ['path']],
  [BotGroupRemoteMemberSchema, ['environmentId', 'botId']],
  [BotGroupSchema.shape.members.element, ['sessionId']],
  [BotGroupSchema.shape.threads.unwrap().element, ['id']]
])

function unwrapped(schema: z.ZodType): z.ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly
  ) {
    return unwrapped(schema.def.innerType)
  }
  return schema instanceof z.ZodPipe ? unwrapped(schema.def.in) : schema
}

export function keptEntryId(entry: unknown, id: readonly string[]): string | null {
  if (!isJson(entry) || id.some((field) => typeof entry[field] !== 'string')) {
    return null
  }
  return JSON.stringify(id.map((field) => entry[field]))
}

function keptObject(next: Json, stored: Json, shape: Record<string, z.ZodType>): Json {
  const kept: Json = {}
  for (const [key, value] of Object.entries(next)) {
    kept[key] = Object.hasOwn(shape, key) ? keptValue(value, stored[key], shape[key]) : value
  }
  for (const [key, value] of Object.entries(stored)) {
    if (!Object.hasOwn(next, key) && !Object.hasOwn(shape, key)) {
      kept[key] = value
    }
  }
  return kept
}

/** `next` with what `stored` holds that `schema` doesn't describe. Lists of records match
 *  entries by id, a union's branch only the same branch; anything else stays `next`'s. */
function keptValue(next: unknown, stored: unknown, schema: z.ZodType): unknown {
  const inner = unwrapped(schema)
  if (inner instanceof z.ZodObject) {
    return isJson(next) && isJson(stored) ? keptObject(next, stored, inner.shape) : next
  }
  if (inner instanceof z.ZodDiscriminatedUnion && isJson(next) && isJson(stored)) {
    const key = inner.def.discriminator
    const branch = inner.options.find((option) => {
      const tag = option instanceof z.ZodObject ? unwrapped(option.shape[key]) : null
      return tag instanceof z.ZodLiteral && [...tag.values].some((value) => value === next[key])
    })
    return branch instanceof z.ZodObject && next[key] === stored[key]
      ? keptObject(next, stored, branch.shape)
      : next
  }
  if (inner instanceof z.ZodArray && Array.isArray(next) && Array.isArray(stored)) {
    const element = unwrapped(inner.element)
    const id = ENTRY_IDS.get(element)
    if (!id) {
      return next
    }
    const byId = new Map(stored.map((entry) => [keptEntryId(entry, id), entry]))
    return next.map((entry) => {
      const key = keptEntryId(entry, id)
      return key === null ? entry : keptValue(entry, byId.get(key), element)
    })
  }
  return next
}

// A legacy group's keys too, so its migration drops what it moved.
const StoredGroupSchema = BotGroupSchema.extend(
  LegacyBotGroupSchema.pick({ anchorSessionId: true }).shape
)
const RosterSchema = unwrapped(BotGroupSchema.shape.remoteMembers)
const MEMBER_ID = ENTRY_IDS.get(BotGroupRemoteMemberSchema)!

export function parsedRecord(text: unknown): Json | null {
  try {
    const record: unknown = typeof text === 'string' ? JSON.parse(text) : null
    return isJson(record) ? record : null
  } catch {
    return null
  }
}

/** A list written by a build that couldn't read the stored one: the stored entries it never wrote
 *  (`seen` names those it did, then removed) first, then what it wrote, so it adds to the list
 *  and never clears what it couldn't see. */
export function withUnreadEntries(
  written: readonly unknown[],
  stored: readonly unknown[],
  id: readonly string[],
  seen: ReadonlySet<string | null> = new Set()
): unknown[] {
  const ids = new Set(written.map((entry) => keptEntryId(entry, id)))
  const hidden = stored.filter((entry) => {
    const key = keptEntryId(entry, id)
    return !ids.has(key) && !seen.has(key)
  })
  return [...hidden, ...written]
}

/** The record's text with the marker first, where the database finds it without parsing. */
export function marked({ [KEEPS_KEYS]: _mark, ...record }: Json): string {
  return JSON.stringify({ [KEEPS_KEYS]: true, ...record })
}

/** The group this build writes over `stored`, with what a newer build stored on it. A paired
 *  roster this build can't read was never shown here, so what it writes adds to it. */
export function keptGroup(stored: Json | null, group: Json): Json {
  if (!stored) {
    return group
  }
  const kept = keptObject(group, stored, StoredGroupSchema.shape)
  const roster = stored.remoteMembers
  if (!Array.isArray(roster) || RosterSchema.safeParse(roster).success) {
    return kept
  }
  const written = Array.isArray(kept.remoteMembers) ? kept.remoteMembers : []
  return { ...kept, remoteMembers: withUnreadEntries(written, roster, MEMBER_ID) }
}

const MessageRecordSchema = BotGroupMessageSchema.omit({ sequence: true })

/** The post this build writes over `stored`, with what a newer build stored on it. */
export function keptMessage(stored: Json | null, message: Json): Json {
  return stored ? keptObject(message, stored, MessageRecordSchema.shape) : message
}
