import { describe, expect, it } from 'vitest'
import { assertHerdrSchemaCompatible, REQUIRED_HERDR_METHODS } from './herdr-runtime-contract'
import { buildHerdrApiSchema, HERDR_PROTOCOL_VERSION } from './herdr-daemon-schema'

describe('herdr daemon API schema', () => {
  it('serves protocol 19 with schema version 1', () => {
    const schema = buildHerdrApiSchema()
    expect(schema.protocol).toBe(HERDR_PROTOCOL_VERSION)
    expect(schema.schema_version).toBe(1)
  })

  it('declares every required stock method', () => {
    const schema = buildHerdrApiSchema()
    const declared = new Set<string>()
    for (const entry of schema.schemas.request as { const: string }[]) {
      if (entry && typeof entry.const === 'string') {
        declared.add(entry.const)
      }
    }
    for (const method of REQUIRED_HERDR_METHODS) {
      expect(declared.has(method), `schema is missing ${method}`).toBe(true)
    }
  })

  it('passes the client compatibility check', () => {
    expect(() => assertHerdrSchemaCompatible(buildHerdrApiSchema())).not.toThrow()
  })
})
