// New closed-set values can look corrupt to older clients; review them alongside row-version changes.

import { expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { AgentJournalItemBodySchema } from '../../../shared/agent-session-journal-schemas'
import { KNOWN_MUTATION_KINDS, KNOWN_ROW_KINDS } from './journal-row-schema'

type ClosedValue = string | number | boolean | null
type ClosedSets = Record<string, ClosedValue[]>

const LEAVES = new Set(['string', 'number', 'boolean', 'unknown', 'any', 'null', 'undefined'])

function isClosedValue(value: unknown): value is ClosedValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  )
}

/** Collect closed sets; catch-all union tags stay open. Reject unknown schema nodes to avoid coverage gaps. */
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

// Changing closed sets requires an explicit row-version compatibility decision.
const SNAPSHOT = {
  v: 4,
  closed: {
    'row.kind': [
      'dispatch',
      'epoch',
      'item',
      'lifecycle-batch',
      'queue',
      'submission',
      'tombstone'
    ],
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
