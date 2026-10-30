import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BUNDLED_AGENT_STATE_RULE_FILES,
  parseAgentStateRuleFiles,
  RAW_BUNDLED_AGENT_STATE_RULE_FILES
} from './agent-state-rules-catalog'
import { AgentStateRulesFileSchema } from './agent-state-rules-schema'

// Kinds whose parse output can differ from their input.
const OUTPUT_CHANGING_KINDS = new Set(['pipe', 'transform', 'default', 'prefault', 'catch'])

function isZodSchema(value: unknown): value is z.core.$ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value
}

function isZodCheck(value: unknown): value is z.core.$ZodCheck {
  return typeof value === 'object' && value !== null && '_zod' in value
}

/** Checks such as `.trim()`, `.toLowerCase()` and `.overwrite()` rewrite the value they validate. */
function rewritingChecks(checks: unknown): string[] {
  if (!Array.isArray(checks)) {
    return []
  }
  return checks.flatMap((check: unknown) => {
    if (!isZodCheck(check)) {
      return []
    }
    const checkDef: Record<string, unknown> = { ...check._zod.def }
    return checkDef.check === 'overwrite' ? ['overwrite check'] : []
  })
}

/** Every reachable schema kind that would change parse output, a coercing primitive, or a rewriting check. */
function outputChangingKinds(schema: z.core.$ZodType, seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) {
    return []
  }
  seen.add(schema)
  const def: Record<string, unknown> = { ...schema._zod.def }
  const found = OUTPUT_CHANGING_KINDS.has(String(def.type)) ? [String(def.type)] : []
  if (def.coerce === true) {
    found.push(`coerced ${String(def.type)}`)
  }
  found.push(...rewritingChecks(def.checks))
  const children: unknown[] = [
    def.innerType,
    def.element,
    def.in,
    def.out,
    // Intersections, object catchalls, and map or record keys and values.
    def.left,
    def.right,
    def.catchall,
    def.keyType,
    def.valueType,
    def.rest,
    ...(Array.isArray(def.options) ? def.options : []),
    ...(Array.isArray(def.items) ? def.items : []),
    ...(def.shape && typeof def.shape === 'object' ? Object.values(def.shape) : []),
    ...(typeof def.getter === 'function' ? [def.getter()] : [])
  ]
  for (const child of children) {
    if (isZodSchema(child)) {
      found.push(...outputChangingKinds(child, seen))
    }
  }
  return found
}

describe('bundled agent state rule files', () => {
  it('are used as bundled, without parsing, so parsing must not change them', () => {
    expect(BUNDLED_AGENT_STATE_RULE_FILES).toBe(RAW_BUNDLED_AGENT_STATE_RULE_FILES)
    expect(parseAgentStateRuleFiles(RAW_BUNDLED_AGENT_STATE_RULE_FILES)).toStrictEqual(
      RAW_BUNDLED_AGENT_STATE_RULE_FILES
    )
  })

  it('keep a schema whose parse output always equals its input', () => {
    expect(outputChangingKinds(AgentStateRulesFileSchema)).toEqual([])
  })

  it('would catch a transform, default or coercion added to the schema', () => {
    expect(outputChangingKinds(z.object({ a: z.string().default('x') }))).toEqual(['default'])
    expect(outputChangingKinds(z.object({ a: z.string().transform((v) => v) }))).toEqual([
      'pipe',
      'transform'
    ])
    expect(outputChangingKinds(z.array(z.coerce.number()))).toEqual(['coerced number'])
  })

  it('would catch a value-rewriting check such as trim, lowercase or overwrite', () => {
    expect(outputChangingKinds(z.object({ a: z.string().trim() }))).toEqual(['overwrite check'])
    expect(outputChangingKinds(z.object({ a: z.string().toLowerCase() }))).toEqual([
      'overwrite check'
    ])
    expect(outputChangingKinds(z.string().overwrite((value) => value))).toEqual(['overwrite check'])
    expect(outputChangingKinds(z.literal('idle').check(z.trim()))).toEqual(['overwrite check'])
  })

  it('looks inside intersections, object catchalls, maps and records', () => {
    const rewriting = z.string().default('x')
    expect(outputChangingKinds(z.intersection(z.object({}), z.object({ a: rewriting })))).toEqual([
      'default'
    ])
    expect(outputChangingKinds(z.intersection(z.object({ a: rewriting }), z.object({})))).toEqual([
      'default'
    ])
    expect(outputChangingKinds(z.object({}).catchall(z.string().trim()))).toEqual([
      'overwrite check'
    ])
    expect(outputChangingKinds(z.map(z.string(), rewriting))).toEqual(['default'])
    expect(outputChangingKinds(z.map(z.string().toLowerCase(), z.number()))).toEqual([
      'overwrite check'
    ])
    expect(outputChangingKinds(z.record(z.string(), z.string().trim()))).toEqual([
      'overwrite check'
    ])
  })
})
