import { z } from 'zod'
import { storedMessageBody } from '../native-chat/agent-session-journal/durable-rows/journal-storage-schema'
import { strictStorage } from '../native-chat/agent-session-journal/durable-rows/journal-storage-strict'
import { journalInputSource } from '../native-chat/agent-session-journal/input-order/journal-input-source-schema'
import {
  outcomeFormat1Stored,
  outcomeFormat1StoredScalars
} from '../native-chat/agent-session-journal/outcomes/journal-outcome-format-1'
import {
  inputCardSchema,
  inputEntrySchema
} from '../native-chat/agent-session-journal/outcomes/journal-outcome-format-2'

// Runs against this build and, through the floor generator, inside the floor's checkout: it names
// only schemas both export. The outcome format files are frozen; what drifts is the shared item,
// message and handle schemas they embed, which every strict read below closes.

/** The saved shapes the floor reads strictly: a key or union tag it doesn't declare refuses the chat. */
function strictlyReadSchemas(): Record<string, z.ZodType> {
  return {
    ...Object.fromEntries(
      Object.entries(outcomeFormat1Stored).map(([field, schema]) => [`outcome.${field}`, schema])
    ),
    ...Object.fromEntries(
      Object.entries(outcomeFormat1StoredScalars.shape).map(([key, schema]) => [
        `outcome.$.${key}`,
        schema
      ])
    ),
    'outcome.inputEntries': inputEntrySchema,
    'outcome.inputCards': inputCardSchema,
    inputSource: journalInputSource,
    queuedMessageBody: storedMessageBody
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOpenString = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === 'string' &&
  value.const === undefined &&
  value.enum === undefined

/** Every object key, union tag and enum value under `node`, as `path.key` or `path=value`. */
function collectVocabulary(
  node: unknown,
  path: string,
  defs: Record<string, unknown>,
  out: Set<string>,
  resolving: ReadonlySet<string>,
  openStrings = false
): void {
  if (!isRecord(node)) {
    return
  }
  const ref = typeof node.$ref === 'string' ? node.$ref.replace(/^#\/\$defs\//, '') : null
  if (ref !== null && !resolving.has(ref)) {
    collectVocabulary(defs[ref], path, defs, out, new Set([...resolving, ref]), openStrings)
  }
  // A string the floor reads openly accepts any value, so its listed values aren't vocabulary.
  if (!openStrings && node.const !== undefined) {
    out.add(`${path}=${JSON.stringify(node.const)}`)
  }
  if (!openStrings && Array.isArray(node.enum)) {
    for (const value of node.enum) {
      out.add(`${path}=${JSON.stringify(value)}`)
    }
  }
  if (isRecord(node.properties)) {
    for (const [key, value] of Object.entries(node.properties)) {
      out.add(`${path}.${key}`)
      collectVocabulary(value, `${path}.${key}`, defs, out, resolving)
    }
  }
  if (isRecord(node.additionalProperties)) {
    collectVocabulary(node.additionalProperties, `${path}.*`, defs, out, resolving)
  }
  if (Array.isArray(node.prefixItems)) {
    node.prefixItems.forEach((item, index) =>
      collectVocabulary(item, `${path}[${index}]`, defs, out, resolving)
    )
  }
  collectVocabulary(node.items, `${path}[]`, defs, out, resolving)
  for (const options of [node.anyOf, node.oneOf, node.allOf]) {
    if (Array.isArray(options)) {
      const open = options.some(isOpenString)
      for (const option of options) {
        collectVocabulary(option, path, defs, out, resolving, open)
      }
    }
  }
}

/** The keys, union tags and enum values the floor's strict reads declare, sorted. */
export function journalStorageVocabulary(): string[] {
  const out = new Set<string>()
  for (const [name, schema] of Object.entries(strictlyReadSchemas())) {
    const json = z.toJSONSchema(strictStorage(schema), { io: 'input', unrepresentable: 'any' })
    const defs = isRecord(json.$defs) ? json.$defs : {}
    collectVocabulary(json, name, defs, out, new Set())
  }
  return [...out].sort()
}

const parentPath = (path: string): string | null =>
  /^(.*?)(?:=[^=]*|\.[^.[\]]*|\[\d*\])$/.exec(path)?.[1] ?? null

/** Vocabulary in `current` but not `floor`, each reported at its outermost new path. */
export function newVocabularyRoots(current: readonly string[], floor: readonly string[]): string[] {
  const floorSet = new Set(floor)
  const added = new Set(current.filter((path) => !floorSet.has(path)))
  return [...added].filter((path) => {
    for (let parent = parentPath(path); parent; parent = parentPath(parent)) {
      if (added.has(parent)) {
        return false
      }
      if (floorSet.has(parent)) {
        return true
      }
    }
    return true
  })
}
