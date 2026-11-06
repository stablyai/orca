import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getCompiledSchema } from './zod-schema-compilation'

describe('getCompiledSchema', () => {
  it('compiles once per schema identity and leaves the original parser untouched', () => {
    const schema = z.object({ value: z.string() })
    const compiled = getCompiledSchema(schema)
    expect(compiled).not.toBe(schema)
    expect(getCompiledSchema(schema)).toBe(compiled)
    expect(getCompiledSchema(z.object({ value: z.string() }))).not.toBe(compiled)
    expect(schema.safeParse({ value: 'ok', extra: true })).toEqual(
      compiled.safeParse({ value: 'ok', extra: true })
    )
  })
})
