import { createIndexedRule } from './indexed-rule'
import { dnrRuleProblem, type DnrRuleProblem } from './parse-errors'
import { readDnrRuleJson } from './rule-schema'
import type { DnrRulesetSource } from './rule-types'
import { DnrRulesetIndex } from './ruleset-index'

// RulesetSource::IndexRules (ruleset_source.cc). Static rulesets skip bad rules with warnings;
// updateDynamicRules / updateSessionRules reject the whole update on the first bad rule.

export type DnrInvalidRulePolicy = 'warn' | 'error'

export type DnrRulesetBuildResult =
  | {
      ok: true
      index: DnrRulesetIndex
      warnings: DnrRuleProblem[]
      ruleCount: number
      regexRuleCount: number
    }
  | { ok: false; error: DnrRuleProblem }

export type DnrRulesetBuildOptions = {
  extensionId: string
  source: DnrRulesetSource
  invalidRules: DnrInvalidRulePolicy
}

export function buildDnrRuleset(
  rules: readonly unknown[],
  options: DnrRulesetBuildOptions
): DnrRulesetBuildResult {
  const steps = indexRules(rules, options, Infinity)
  let step = steps.next()
  while (!step.done) {
    step = steps.next()
  }
  return step.value
}

/** buildDnrRuleset that awaits `pause()` after every `sliceSize` rules, so callers can yield. */
export async function buildDnrRulesetInSlices(
  rules: readonly unknown[],
  options: DnrRulesetBuildOptions,
  sliceSize: number,
  pause: () => Promise<void>
): Promise<DnrRulesetBuildResult> {
  const steps = indexRules(rules, options, sliceSize)
  let step = steps.next()
  while (!step.done) {
    await pause()
    step = steps.next()
  }
  return step.value
}

function* indexRules(
  rules: readonly unknown[],
  options: DnrRulesetBuildOptions,
  sliceSize: number
): Generator<void, DnrRulesetBuildResult> {
  const context = {
    extensionId: options.extensionId,
    isSessionRuleset: options.source.kind === 'session'
  }
  const index = new DnrRulesetIndex()
  let ruleCount = 0
  const warnings: DnrRuleProblem[] = []
  const ids = new Set<number>()
  for (const [position, json] of rules.entries()) {
    if (position > 0 && position % sliceSize === 0) {
      yield
    }
    const read = readDnrRuleJson(json)
    if (!read.ok) {
      const problem: DnrRuleProblem = {
        error: 'schema',
        ruleId: -1,
        message: `Rule at index ${position} couldn't be parsed. Parse error: ${read.message}`
      }
      if (options.invalidRules === 'error') {
        return { ok: false, error: problem }
      }
      warnings.push(problem)
      continue
    }
    const rule = read.rule
    if (ids.has(rule.id)) {
      const problem = dnrRuleProblem('duplicateIds', rule.id)
      if (options.invalidRules === 'error') {
        return { ok: false, error: problem }
      }
      warnings.push(problem)
      continue
    }
    ids.add(rule.id)
    const created = createIndexedRule(rule, context)
    if (!created.ok) {
      if (options.invalidRules === 'error') {
        return { ok: false, error: created.problem }
      }
      warnings.push(created.problem)
      continue
    }
    index.add(created.rule)
    ruleCount++
  }
  index.finish()
  return {
    ok: true,
    index,
    warnings,
    ruleCount,
    regexRuleCount: index.regexRuleCount
  }
}
