import { describe, expect, it } from 'vitest'
import {
  REQUIRED_HERDR_METHODS,
  assertHerdrSchemaCompatible,
  assertHerdrServerCompatible,
  type HerdrApiSchema
} from './herdr-runtime-contract'

const requiredMethods = [...new Set(REQUIRED_HERDR_METHODS)]

function schema(protocol = 19): HerdrApiSchema {
  return {
    protocol,
    schema_version: 1,
    schemas: {
      request: {
        oneOf: requiredMethods.map((method) => ({
          properties: { method: { const: method } }
        }))
      }
    }
  }
}

describe('stock Herdr compatibility', () => {
  it('accepts the public schema surface and matching server protocol', () => {
    expect(() => assertHerdrSchemaCompatible(schema())).not.toThrow()
    expect(() => assertHerdrServerCompatible(schema(), 19)).not.toThrow()
  })

  it('rejects a fork-shaped or stale server without stopping it', () => {
    const incomplete = schema()
    incomplete.schemas = { request: {} }
    expect(() => assertHerdrSchemaCompatible(incomplete)).toThrow(
      'missing required stock API methods'
    )
    expect(() => assertHerdrServerCompatible(schema(), 18)).toThrow(
      'does not match the running server protocol'
    )
  })
})
