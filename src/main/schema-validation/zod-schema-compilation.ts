import { compile, type ZodType } from 'zod'
import { unwrapLazyZodSchema } from '../../shared/schema/lazy-zod-schema'

const compiledSchemas = new WeakMap<ZodType, ZodType>()

// Compile on first use so unused contracts cost nothing during startup.
export function getCompiledSchema<T extends ZodType>(schema: T): T {
  const target = unwrapLazyZodSchema(schema)
  const cached = compiledSchemas.get(target)
  if (cached) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only compile(target), which preserves T, is cached under this exact schema.
    return cached as T
  }
  const compiled = compile(target)
  compiledSchemas.set(target, compiled)
  return compiled
}
