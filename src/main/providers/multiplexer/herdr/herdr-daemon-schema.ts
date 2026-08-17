import {
  HERDR_SCHEMA_VERSION,
  REQUIRED_HERDR_METHODS,
  type HerdrApiSchema
} from './herdr-runtime-contract'

export const HERDR_PROTOCOL_VERSION = 19

// Why: the client's schema walker (schemaDeclaresRequestMethod) only needs a
// {"const": "<method>"} declaration per method; a flat declaration list keeps the
// served schema in lockstep with REQUIRED_HERDR_METHODS.
export function buildHerdrApiSchema(protocol = HERDR_PROTOCOL_VERSION): HerdrApiSchema {
  return {
    protocol,
    schema_version: HERDR_SCHEMA_VERSION,
    schemas: {
      request: REQUIRED_HERDR_METHODS.map((method) => ({ const: method }))
    }
  }
}
