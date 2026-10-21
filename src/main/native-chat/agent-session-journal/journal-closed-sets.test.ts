// Every closed set a journal row is read against: a row kind, a lifecycle mutation kind, and each
// enum, literal or discriminant in a body. A new row or mutation kind, or a bumped row version,
// makes older builds refuse the chat as a newer Orca's ("Update Orca to open it"); a new value in a
// body's closed set at the same version is damage to them ("Unable to load this chat"), where a
// turn's context usage is dropped instead. This snapshot sits beside the row version so that a
// change to either is deliberate.

import { expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { AgentJournalItemBodySchema } from '../../../shared/agent-session-journal-schemas'
import { KNOWN_MUTATION_KINDS, KNOWN_ROW_KINDS } from './journal-row-schema'

type ClosedValue = string | number | boolean | null
type ClosedSets = Record<string, ClosedValue[]>

/** Nodes that hold no closed set and nothing nested. */
const LEAVES = new Set(['string', 'number', 'boolean', 'unknown', 'any', 'null', 'undefined'])

function isClosedValue(value: unknown): value is ClosedValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  )
}

/** Walks a schema and collects, by path, every value a closed node allows. A plain union whose
 *  other arm takes any string for a discriminated arm's tag (blocks, goal states) is open there:
 *  older builds read a new tag as-is, so that path is listed apart. Throws on a node kind it does
 *  not know, so a new kind of schema cannot hide a closed set from this test. */
function collectClosedSets(
  schema: z.core.$ZodType,
  path: string,
  into: { closed: ClosedSets; catchAll: string[] }
): void {
  const join = (key: string) => (path ? `${path}.${key}` : key)
  if (schema instanceof z.ZodLiteral || schema instanceof z.ZodEnum) {
    const kept = (into.closed[path] ??= [])
    const values = schema instanceof z.ZodLiteral ? [...schema.values] : schema.options
    for (const value of values) {
      if (isClosedValue(value) && !kept.includes(value)) {
        kept.push(value)
      }
    }
    kept.sort((left, right) => String(left).localeCompare(String(right)))
  } else if (schema instanceof z.ZodObject) {
    for (const [key, field] of Object.entries(schema.shape)) {
      collectClosedSets(field, join(key), into)
    }
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    collectClosedSets(schema.unwrap(), path, into)
  } else if (schema instanceof z.ZodArray) {
    collectClosedSets(schema.element, `${path}[]`, into)
  } else if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      collectClosedSets(option, path, into)
    }
    for (const tag of catchAllTags(schema.options)) {
      delete into.closed[join(tag)]
      into.catchAll.push(join(tag))
    }
  } else if (!LEAVES.has(schema._zod.def.type)) {
    throw new Error(`no rule for a ${schema._zod.def.type} schema at ${path || 'the root'}`)
  }
}

/** Tags a discriminated arm keys on that another arm of the same union accepts as any string. */
function catchAllTags(options: readonly z.core.$ZodType[]): string[] {
  const tags = options.flatMap((option) =>
    option instanceof z.ZodDiscriminatedUnion ? [option.def.discriminator] : []
  )
  return tags.filter((tag) =>
    options.some(
      (option) => option instanceof z.ZodObject && option.shape[tag] instanceof z.ZodString
    )
  )
}

function journalClosedSets() {
  const closed: ClosedSets = {
    'row.kind': [...KNOWN_ROW_KINDS.keys()].sort(),
    'row.mutations[].kind': [...KNOWN_MUTATION_KINDS.keys()].sort()
  }
  const into = { closed, catchAll: new Array<string>() }
  collectClosedSets(AgentJournalItemBodySchema, 'body', into)
  return { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, ...into }
}

/** Recorded with the row version it holds for. Change it only together with that decision. */
const SNAPSHOT = {
  v: 3,
  closed: {
    'row.kind': ['dispatch', 'epoch', 'item', 'lifecycle-batch', 'submission', 'tombstone'],
    'row.mutations[].kind': ['item', 'tombstone'],
    'body.contextUsage.used.kind': ['estimate', 'report', 'unknown'],
    'body.contextUsage.used.categories[].deferred': [true]
  },
  catchAll: ['body.blocks[].type', 'body.subject.kind', 'body.threadGoal.state', 'body.kind']
}

it('changes no closed set of a journal row without the row version', () => {
  expect(
    journalClosedSets(),
    'A new closed-set value without a row-version bump makes older builds call the chat ' +
      'damaged, where with the bump they say to update Orca. Bump v, then update this snapshot.'
  ).toEqual(SNAPSHOT)
})
