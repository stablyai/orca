import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  terminalSendAcceptedSchema,
  terminalViewportUpdatedSchema,
  terminalWriteUnreadReplySchema
} from './terminal-reply-schema'

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

describe('a terminal send is delivered only on an exact true', () => {
  it('reads the accepted envelope', () => {
    expect(reads(terminalSendAcceptedSchema, { send: { accepted: true } })).toBe(true)
    expect(reads(terminalSendAcceptedSchema, { send: { accepted: false } })).toBe(false)
  })

  it('reads every other shape as not delivered rather than as an error', () => {
    expect(reads(terminalSendAcceptedSchema, {})).toBe(false)
    expect(reads(terminalSendAcceptedSchema, { send: null })).toBe(false)
    expect(reads(terminalSendAcceptedSchema, { send: 'accepted' })).toBe(false)
    expect(reads(terminalSendAcceptedSchema, { send: { accepted: 'yes' } })).toBe(false)
    expect(reads(terminalSendAcceptedSchema, { error: 'refused' })).toBe(false)
  })
})

describe('a viewport update projects both flags through an exact true', () => {
  it('reads what the runtime recorded and whether it re-fitted', () => {
    expect(reads(terminalViewportUpdatedSchema, { updated: true, applied: true })).toEqual({
      updated: true,
      applied: true
    })
    expect(reads(terminalViewportUpdatedSchema, { updated: true, applied: false })).toEqual({
      updated: true,
      applied: false
    })
  })

  it('falls through to the legacy resubscribe for anything that is not exactly true', () => {
    expect(reads(terminalViewportUpdatedSchema, {})).toEqual({ updated: false, applied: false })
    expect(reads(terminalViewportUpdatedSchema, { updated: 1, applied: 1 })).toEqual({
      updated: false,
      applied: false
    })
  })

  it('passes the seq the host also sends through without declaring it', () => {
    expect(reads(terminalViewportUpdatedSchema, { updated: true, applied: true, seq: 9 })).toEqual({
      updated: true,
      applied: true
    })
  })
})

describe('the two terminal writes whose body nothing reads', () => {
  it('takes every reply shape', () => {
    expect(refuses(terminalWriteUnreadReplySchema, undefined)).toBe(false)
    expect(refuses(terminalWriteUnreadReplySchema, null)).toBe(false)
    expect(refuses(terminalWriteUnreadReplySchema, { changed: 1 })).toBe(false)
  })
})
