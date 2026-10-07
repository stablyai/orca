import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  browserCommandUnreadReplySchema,
  browserNavigationSettledSchema
} from './browser-command-reply-schema'

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

describe('a navigation reports the URL it settled on', () => {
  it('reads the settled URL the address bar takes', () => {
    expect(reads(browserNavigationSettledSchema, { url: 'https://example.test/' }).url).toBe(
      'https://example.test/'
    )
  })

  it('leaves the address bar alone for a reply that names no URL', () => {
    expect(reads(browserNavigationSettledSchema, {}).url).toBe(undefined)
    expect(reads(browserNavigationSettledSchema, { url: 7 }).url).toBe(undefined)
  })

  it('leaves the address bar alone for a null or absent result, as the pane always did', () => {
    expect(reads(browserNavigationSettledSchema, null)).toBe(null)
    expect(reads(browserNavigationSettledSchema, undefined)).toBe(undefined)
  })
})

describe('the twelve commands whose body nothing reads', () => {
  it('take every reply shape', () => {
    expect(refuses(browserCommandUnreadReplySchema, undefined)).toBe(false)
    expect(refuses(browserCommandUnreadReplySchema, null)).toBe(false)
    expect(refuses(browserCommandUnreadReplySchema, { ok: true })).toBe(false)
  })
})
