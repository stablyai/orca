import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { hostStatusSchema } from './host-status-reply-schema'

function reads<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`expected a readable reply: ${parsed.error.message}`)
  }
  return parsed.data
}

function refuses(schema: z.ZodType<unknown, unknown>, value: unknown): boolean {
  return !schema.safeParse(value).success
}

describe('the host status decodes from every version the gate admits', () => {
  it('reads the status a current host sends', () => {
    const status = {
      protocolVersion: 5,
      minCompatibleMobileVersion: 1,
      appVersion: '1.4.200',
      capabilities: ['mobile.tasks.v1', 'push.v1'],
      floatingWorkspaceEnabled: true
    }
    expect(reads(hostStatusSchema, status)).toMatchObject(status)
  })

  it('reads a host that answers none of the five fields', () => {
    expect(reads(hostStatusSchema, {})).toEqual({})
    expect(reads(hostStatusSchema, { error: 'refused' })).toMatchObject({ error: 'refused' })
  })

  it('names a reply that is not a status object at all', () => {
    expect(refuses(hostStatusSchema, null)).toBe(true)
    expect(refuses(hostStatusSchema, undefined)).toBe(true)
  })
})

describe('capabilities salvage whole, not per element', () => {
  it('keeps a list of strings', () => {
    expect(reads(hostStatusSchema, { capabilities: ['a', 'b'] }).capabilities).toEqual(['a', 'b'])
  })

  it('drops the whole list for one non-string, which is what the probe published', () => {
    // transport-capability-probe-non-string-capabilities-drop records main publishing `[]` for
    // `['push.v1', 7]`; dropping only the 7 would publish a set main never published.
    expect(reads(hostStatusSchema, { capabilities: ['push.v1', 7] }).capabilities).toBe(undefined)
    expect(reads(hostStatusSchema, { capabilities: 'push.v1' }).capabilities).toBe(undefined)
  })
})
