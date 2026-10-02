import type { AgentStatus } from '../../../shared/agent-detection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { compileScreenCondition } from './agent-state-rule-matchers'
import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'
import {
  UNKNOWN_PANE_RULES_ID,
  type AgentStateRuleAnswer,
  type AgentStateRuleCondition,
  type AgentStateRulesFile,
  type HookAuthority,
  type NamedScreenPredicate
} from './agent-state-rules-schema'
import { compileTextAnchor } from './agent-state-text-anchors'
import { isSettledAfter } from './blocked-text-layer'
import { isCodexComposerReadyScreen, isCodexHeaderReadyScreen } from './codex-screen-predicates'

/** What the first matching rule answered. Callers rank it among the other readiness lanes. */
export type AgentStateVerdict = { ruleId: string } & AgentStateRuleAnswer

/**
 * The regions a lane lets the rules read. A region that is absent, or null because no trustworthy
 * copy exists, skips the rules that read it: the lane reads only the evidence it ranks.
 */
export type AgentStateRegions = {
  readScreenLines?: () => readonly string[] | null
  /** The lowercased text tail. */
  readText?: () => string
  /** The status the shared title classifier gave the pane title. */
  readTitleStatus?: () => AgentStatus | null
  /** False on a pane with no output clock (restored or adopted); absent reads as clocked. */
  hasOutputClock?: boolean
}

type Region = AgentStateRuleCondition['region']

type RegionReader<T> = () => T | null

type RegionReads = {
  screen: RegionReader<readonly string[]>
  /** The screen joined and lowercased, for named screen predicates. */
  screenText: RegionReader<string>
  text: RegionReader<string>
  title: RegionReader<AgentStatus>
}

type CompiledRule = {
  verdict: AgentStateVerdict
  region: Region
  skipWithoutClock: boolean
  /** False when its region is unreadable, which skips the rule. */
  matches: (reads: RegionReads) => boolean
}

const NAMED_SCREEN_PREDICATES: Record<NamedScreenPredicate, (screen: string) => boolean> = {
  'codex-header-ready': isCodexHeaderReadyScreen,
  'codex-composer-ready': isCodexComposerReadyScreen
}

function readThen<T>(read: RegionReader<T>, test: (value: T) => boolean): boolean {
  const value = read()
  return value !== null && test(value)
}

function compileCondition(
  when: AgentStateRuleCondition,
  file: AgentStateRulesFile
): CompiledRule['matches'] {
  switch (when.region) {
    case 'screen': {
      if (when.predicate) {
        const predicate = NAMED_SCREEN_PREDICATES[when.predicate]
        return (reads) => readThen(reads.screenText, predicate)
      }
      const matches = compileScreenCondition(when)
      return (reads) => readThen(reads.screen, matches)
    }
    case 'title':
      return (reads) => readThen(reads.title, (status) => status === when.status)
    case 'text': {
      const anchor = file.anchors.find((candidate) => candidate.id === when.anchor)
      // Why unreachable: the schema requires the anchor to be one of this file's text anchors.
      if (anchor?.when.region !== 'text') {
        throw new Error(`agent state rules ${file.id}: no text anchor ${when.anchor}`)
      }
      const find = compileTextAnchor(anchor.when, anchor.answer)
      return (reads) =>
        readThen(reads.text, (text) => isSettledAfter(text, find(text)?.index ?? null))
    }
  }
}

export function compileAgentRules(file: AgentStateRulesFile): CompiledRule[] {
  // Why stable: equal priorities keep file order.
  return file.rules
    .toSorted((left, right) => right.priority - left.priority)
    .map((rule) => ({
      verdict: { ruleId: rule.id, ...rule.answer },
      region: rule.when.region,
      skipWithoutClock: rule.answer.state === 'idle' && rule.answer.withoutClock === 'skip',
      matches: compileCondition(rule.when, file)
    }))
}

type RulesKey = TuiAgent | typeof UNKNOWN_PANE_RULES_ID

type CompiledFile = { rules: CompiledRule[]; readsTrustedScreen: boolean; hooks: HookAuthority }

const FILES_BY_KEY: ReadonlyMap<RulesKey, CompiledFile> = new Map(
  BUNDLED_AGENT_STATE_RULE_FILES.map((file) => [
    file.id,
    {
      rules: compileAgentRules(file),
      readsTrustedScreen: file.profile?.screenSource === 'trusted',
      hooks: file.profile?.hooks ?? 'identity-only'
    }
  ])
)

// Why the unknown-pane file for a null agent: an adopted pane can still run a known agent.
function compiledFileFor(agent: TuiAgent | null | undefined): CompiledFile | undefined {
  return FILES_BY_KEY.get(agent ?? UNKNOWN_PANE_RULES_ID)
}

/**
 * Whether the agent's rules read the PTY's trusted grid. Why it changes which screen is read, and
 * how a clockless wait probes: those rules were recorded against that grid, while every other
 * agent keeps the live screen.
 */
export function readsTrustedScreen(agent: TuiAgent | null | undefined): boolean {
  return compiledFileFor(agent)?.readsTrustedScreen ?? false
}

/** Whether a fresh hook row for the agent's main turn decides readiness ahead of its rules. */
export function hooksAreAuthoritative(agent: TuiAgent | null | undefined): boolean {
  return compiledFileFor(agent)?.hooks === 'authoritative'
}

function someRule(
  agent: TuiAgent | null | undefined,
  test: (rule: CompiledRule) => boolean
): boolean {
  return compiledFileFor(agent)?.rules.some(test) ?? false
}

function isStrongQuietIdle(verdict: AgentStateVerdict): boolean {
  return verdict.state === 'idle' && verdict.strength === 'strong' && verdict.requiresQuiet
}

/** Whether the agent has a ready sign it also paints mid-turn, which the quiet lane must read. */
export function hasQuietReadyRules(agent: TuiAgent | null | undefined): boolean {
  return someRule(agent, (rule) => isStrongQuietIdle(rule.verdict))
}

/**
 * Whether the agent's own ready text is held to quiet. Why it shuts the shared text lane on a
 * clocked pane: that lane settles any rule file's ready text at once, which would skip the quiet.
 */
export function holdsReadyTextToQuiet(agent: TuiAgent | null | undefined): boolean {
  return someRule(agent, (rule) => rule.region === 'text' && isStrongQuietIdle(rule.verdict))
}

/** Whether the agent's own idle-title rule waits for quiet; null when it has none. */
export function idleTitleRequiresQuiet(agent: TuiAgent | null | undefined): boolean | null {
  const verdict = compiledFileFor(agent)?.rules.find((rule) => rule.region === 'title')?.verdict
  return verdict?.state === 'idle' ? verdict.requiresQuiet : null
}

function memoize<T>(read: (() => T | null) | undefined): RegionReader<T> {
  if (!read) {
    return () => null
  }
  let value: T | null | undefined
  return () => (value === undefined ? (value = read()) : value)
}

export function evaluateCompiledRules(
  rules: readonly CompiledRule[],
  regions: AgentStateRegions
): AgentStateVerdict | null {
  const screen = memoize(regions.readScreenLines)
  const reads: RegionReads = {
    screen,
    screenText: memoize(() => screen()?.join('\n').toLowerCase() ?? null),
    text: memoize(regions.readText),
    title: memoize(regions.readTitleStatus)
  }
  // Why no answer rather than a refusal: with no readable region the caller's other lanes decide.
  for (const rule of rules) {
    if (rule.skipWithoutClock && regions.hasOutputClock === false) {
      continue
    }
    if (rule.matches(reads)) {
      return rule.verdict
    }
  }
  return null
}

/** The agent's priority list over its regions: the first match answers; none leaves it to the caller. */
export function evaluateAgentStateRules(
  agent: TuiAgent | null | undefined,
  regions: AgentStateRegions
): AgentStateVerdict | null {
  const file = compiledFileFor(agent)
  return file ? evaluateCompiledRules(file.rules, regions) : null
}
