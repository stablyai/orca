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

/** Every reachable schema kind that would change parse output, or a coercing primitive. */
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
  const children: unknown[] = [
    def.innerType,
    def.element,
    def.in,
    def.out,
    def.keyType,
    def.valueType,
    def.rest,
    ...(Array.isArray(def.options) ? def.options : []),
    ...(Array.isArray(def.items) ? def.items : []),
    ...(def.shape && typeof def.shape === 'object' ? Object.values(def.shape) : []),
    ...(typeof def.getter === 'function' ? [def.getter()] : [])
  ]
  for (const child of children) {
    if (child && typeof child === 'object' && '_zod' in child) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every zod schema carries `_zod`; the guard above checks it.
      found.push(...outputChangingKinds(child as z.core.$ZodType, seen))
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
})
