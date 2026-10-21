import { describe, expect, it, vi } from 'vitest'
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

  it('keeps defaults, transforms, stripped keys, and validation errors', () => {
    const schema = z.object({
      value: z.string().trim().min(1, 'Value is required'),
      count: z.number().int().default(1),
      label: z.string().transform((value) => value.toUpperCase())
    })
    const compiled = getCompiledSchema(schema)
    expect(compiled.parse({ value: ' ok ', label: 'label', extra: true })).toEqual({
      value: 'ok',
      count: 1,
      label: 'LABEL'
    })
    const input = { value: '', count: 1.5, label: 'label' }
    const original = schema.safeParse(input)
    const result = compiled.safeParse(input)
    expect(result.success).toBe(false)
    if (!original.success && !result.success) {
      expect(result.error.issues).toEqual(original.error.issues)
    }
  })

  it('caches the runtime fallback for an asynchronous schema', async () => {
    const schema = z.string().refine(async (value) => value === 'ok')
    expect(getCompiledSchema(schema)).toBe(schema)
    expect(getCompiledSchema(schema)).toBe(schema)
    expect((await getCompiledSchema(schema).safeParseAsync('ok')).success).toBe(true)
    expect((await getCompiledSchema(schema).safeParseAsync('bad')).success).toBe(false)
  })

  it('keeps parsing when the host refuses code generation', () => {
    const jitless = z.config().jitless
    z.config({ jitless: true })
    vi.stubGlobal('Function', function () {
      throw new EvalError('Code generation refused')
    })
    try {
      const schema = z.object({ value: z.string() })
      const compiled = getCompiledSchema(schema)
      expect(compiled).toBe(schema)
      expect(getCompiledSchema(schema)).toBe(compiled)
      expect(compiled.parse({ value: 'ok', extra: true })).toEqual({ value: 'ok' })
      expect(compiled.safeParse({ value: 1 }).success).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      z.config({ jitless })
    }
  })
})
