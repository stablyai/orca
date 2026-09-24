import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  codexResetCapabilityListSchema,
  codexResetCreditReplySchema
} from './codex-reset-credit-reply-schema'

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

describe('the two codex reset replies', () => {
  it('drops a capability list carrying a non-string, whole, as main did', () => {
    expect(reads(codexResetCapabilityListSchema, { capabilities: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(reads(codexResetCapabilityListSchema, { capabilities: ['a', 7] })).toBe(undefined)
    expect(reads(codexResetCapabilityListSchema, {})).toBe(undefined)
  })

  it('forwards the redeem reply whole to decodeResetResult', () => {
    expect(refuses(codexResetCreditReplySchema, null)).toBe(false)
    expect(refuses(codexResetCreditReplySchema, { outcome: 'reset' })).toBe(false)
  })
})
