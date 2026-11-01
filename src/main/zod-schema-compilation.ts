import { compile, type ZodType } from 'zod'

const compiledSchemas = new WeakMap<ZodType, ZodType>()

// Compile on first use so unused contracts cost nothing during startup.
export function getCompiledSchema<T extends ZodType>(schema: T): T {
  const cached = compiledSchemas.get(schema)
  if (cached) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only compile(schema), which preserves T, is cached under this exact schema.
    return cached as T
  }
  const compiled = compile(schema)
  compiledSchemas.set(schema, compiled)
  return compiled
}
