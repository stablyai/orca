import type { AgentStatus } from '../../../shared/agent-detection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { compileScreenCondition } from './agent-state-rule-matchers'
import { compiledFromActiveAgentStateRules } from './active-agent-state-rules'
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

export type AgentStateVerdict = { ruleId: string } & AgentStateRuleAnswer

/** Missing/untrusted regions skip their rules; each lane reads only the evidence it ranks. */
export type AgentStateRegions = {
  readScreenLines?: () => readonly string[] | null
  /** Lowercased text tail. */
  readText?: () => string
  readTitleStatus?: () => AgentStatus | null
  /** False for restored/adopted panes without an output clock; absent means clocked. */
  hasOutputClock?: boolean
}

type Region = AgentStateRuleCondition['region']

type RegionReader<T> = () => T | null

type RegionReads = {
  screen: RegionReader<readonly string[]>
  /** Joined, lowercased screen for named predicates. */
  screenText: RegionReader<string>
  text: RegionReader<string>
  title: RegionReader<AgentStatus>
}

type CompiledRule = {
  verdict: AgentStateVerdict
  region: Region
  skipWithoutClock: boolean
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
      // Schema validation guarantees this file owns the text anchor.
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

const filesByKey = compiledFromActiveAgentStateRules(
  (files): ReadonlyMap<RulesKey, CompiledFile> =>
    new Map(
      files.map((file) => [
        file.id,
        {
          rules: compileAgentRules(file),
          readsTrustedScreen: file.profile?.screenSource === 'trusted',
          hooks: file.profile?.hooks ?? 'identity-only'
        }
      ])
    )
)

// Adopted panes can run a known agent without a launch identity.
function compiledFileFor(agent: TuiAgent | null | undefined): CompiledFile | undefined {
  return filesByKey().get(agent ?? UNKNOWN_PANE_RULES_ID)
}

/** Preserve the grid the rules were recorded against; also determines clockless wait probing. */
export function readsTrustedScreen(agent: TuiAgent | null | undefined): boolean {
  return compiledFileFor(agent)?.readsTrustedScreen ?? false
}

export function hookAuthority(agent: TuiAgent | null | undefined): HookAuthority {
  return compiledFileFor(agent)?.hooks ?? 'identity-only'
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

export function hasQuietReadyRules(agent: TuiAgent | null | undefined): boolean {
  return someRule(agent, (rule) => isStrongQuietIdle(rule.verdict))
}

/** Shut the shared immediate text lane when this agent's ready text must wait for quiet. */
export function holdsReadyTextToQuiet(agent: TuiAgent | null | undefined): boolean {
  return someRule(agent, (rule) => rule.region === 'text' && isStrongQuietIdle(rule.verdict))
}

/** Null means this agent has no idle-title rule. */
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
  // Unreadable regions leave the verdict to other lanes.
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

/** First match wins; no match leaves the verdict to the caller. */
export function evaluateAgentStateRules(
  agent: TuiAgent | null | undefined,
  regions: AgentStateRegions
): AgentStateVerdict | null {
  const file = compiledFileFor(agent)
  return file ? evaluateCompiledRules(file.rules, regions) : null
}
