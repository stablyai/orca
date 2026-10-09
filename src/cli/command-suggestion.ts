import { specPaths, type CommandSpec } from './command-spec'
import { levenshtein } from '../shared/edit-distance'

// Why: rank the live registry so typo recovery cannot drift from accepted paths.

const SUGGESTION_THRESHOLD = 3
const MAX_SUGGESTIONS = 3

// Why: a close typo of a destructive verb (`remov`→`remove`) still signals that
// intent, but `move` (distance 2 from `remove`) does not — keep this at 1 so
// genuine recovery works while unrelated verbs stay locked out. #6303
const DESTRUCTIVE_INTENT_THRESHOLD = 1

function finalToken(path: string[]): string {
  return path.at(-1) ?? ''
}

// Why: destructiveness is declared on the spec (single source of truth); the
// intent verbs are the final tokens of every destructive path/alias so the guard
// tracks the registry instead of a hand-maintained list.
function destructiveVerbs(specs: CommandSpec[]): Set<string> {
  const verbs = new Set<string>()
  for (const spec of specs) {
    if (spec.destructive) {
      for (const path of specPaths(spec)) {
        verbs.add(finalToken(path))
      }
    }
  }
  return verbs
}

// Why: deletion is irreversible and suggestions flow into agents' recovery
// channel (--json nextSteps), so only unlock destructive candidates when the
// input token is itself a near-miss of a destructive verb. #6303
function intendsDestruction(inputToken: string, verbs: Set<string>): boolean {
  for (const verb of verbs) {
    if (
      Math.abs(inputToken.length - verb.length) <= DESTRUCTIVE_INTENT_THRESHOLD &&
      levenshtein(inputToken, verb) <= DESTRUCTIVE_INTENT_THRESHOLD
    ) {
      return true
    }
  }
  return false
}

export type CommandErrorData = {
  suggestions: string[]
  nextSteps: string[]
}

// Why: one bounded near-match ranking keeps command and flag recovery consistent.
function rankByDistance(scored: { label: string; distance: number }[]): string[] {
  return scored
    .filter((entry) => entry.distance <= SUGGESTION_THRESHOLD)
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.label)
}

// Why: edit distance cannot recover a rename. Agents open pages with `orca browser open <url>`
// or `orca navigate <url>`; only the real verb gets them there.
const COMMAND_SYNONYMS: Readonly<Record<string, string>> = {
  open: 'tab create',
  navigate: 'goto'
}

// A typed path that recovers to `label`: the spec's own path, or its group-prefixed form.
type RecoveryCandidate = { tokens: string[]; label: string }

function recoveryCandidates(spec: CommandSpec, singleToken: boolean): RecoveryCandidate[] {
  const candidates: RecoveryCandidate[] = []
  for (const path of specPaths(spec)) {
    const label = path.join(' ')
    // Why: a lone token recovers to a command group, not to one of its leaves.
    candidates.push(
      singleToken ? { tokens: path.slice(0, 1), label: path[0] } : { tokens: path, label }
    )
    if (spec.group && !singleToken) {
      candidates.push({ tokens: [spec.group, ...path], label })
    }
  }
  return candidates
}

function isCommandGroupName(specs: CommandSpec[], token: string | undefined): boolean {
  return specs.some((spec) => spec.group === token && !spec.hidden)
}

function synonymSuggestion(specs: CommandSpec[], commandPath: string[]): string | undefined {
  const verb = isCommandGroupName(specs, commandPath[0]) ? commandPath[1] : commandPath[0]
  const target = verb === undefined ? undefined : COMMAND_SYNONYMS[verb]
  return specs.some((spec) => !spec.hidden && spec.path.join(' ') === target) ? target : undefined
}

function visiblePathPrefixes(specs: CommandSpec[]): Set<string> {
  const prefixes = new Set<string>()
  for (const spec of specs) {
    if (spec.hidden) {
      continue
    }
    for (const path of specPaths(spec)) {
      for (let length = 1; length <= path.length; length += 1) {
        prefixes.add(path.slice(0, length).join(' '))
      }
    }
  }
  return prefixes
}

// Why: candidates are compared with the same number of leading tokens, so trailing operands
// (`tab creat https://example.com`) cannot hide a near miss and parent groups never match.
export function suggestCommands(specs: CommandSpec[], commandPath: string[]): string[] {
  const synonym = synonymSuggestion(specs, commandPath)
  if (synonym) {
    return [synonym]
  }
  const verbs = destructiveVerbs(specs)
  const knownPrefixes = visiblePathPrefixes(specs)
  const singleToken = commandPath.length === 1
  // Distance per label, per number of typed tokens the candidate explains.
  const byDepth = new Map<number, Map<string, number>>()
  for (const spec of specs) {
    if (spec.hidden) {
      continue
    }
    for (const { tokens, label } of recoveryCandidates(spec, singleToken)) {
      const depth = tokens.length
      if (depth > commandPath.length) {
        continue
      }
      // Why: only surface destructive commands when the user actually reached for one;
      // otherwise a benign typo could recover into an irreversible action. #6303
      if (spec.destructive && !intendsDestruction(commandPath[depth - 1], verbs)) {
        continue
      }
      const typed = commandPath.slice(0, depth).join(' ')
      // Why: a shorter prefix that already names a real path (`tab` in `tab lst`) is not a typo.
      if (typed === label || (depth < commandPath.length && knownPrefixes.has(typed))) {
        continue
      }
      const joined = tokens.join(' ')
      if (Math.abs(typed.length - joined.length) > SUGGESTION_THRESHOLD) {
        continue
      }
      const distance = levenshtein(typed, joined)
      if (distance > SUGGESTION_THRESHOLD) {
        continue
      }
      const scores = byDepth.get(depth) ?? new Map<string, number>()
      scores.set(label, Math.min(distance, scores.get(label) ?? distance))
      byDepth.set(depth, scores)
    }
  }
  // Why: the match that explains the most typed tokens wins; shorter ones are mostly noise.
  const deepest = Math.max(0, ...byDepth.keys())
  const scored = [...(byDepth.get(deepest) ?? [])].map(([label, distance]) => ({ label, distance }))
  // Why: an exact group-prefixed hit (`browser screenshot`) is the answer, not one of several.
  const exact = scored.filter((entry) => entry.distance === 0)
  return rankByDistance(exact.length > 0 ? exact : scored)
}

export function unknownCommandData(specs: CommandSpec[], commandPath: string[]): CommandErrorData {
  const suggestions = suggestCommands(specs, commandPath)
  const nextSteps = suggestions.length
    ? [`Did you mean: ${suggestions.map((path) => `orca ${path}`).join(', ')}`]
    : []
  const group = commandPath[0]
  if (
    commandPath.length > 1 &&
    isCommandGroupName(specs, group) &&
    !visiblePathPrefixes(specs).has(commandPath.slice(0, 2).join(' ')) &&
    !suggestions.some((path) => path.startsWith(`${group} `))
  ) {
    nextSteps.push(
      `Orca's ${group} commands run at the top level (orca <command>, not orca ${group} <command>); list them with: orca ${group} --help`
    )
  }
  return { suggestions, nextSteps }
}

export type FlagErrorData = {
  validFlags: string[]
  suggestions: string[]
  nextSteps: string[]
}

// Why: edit distance cannot recover a rename. `orchestration check` is the one verb
// that identifies its caller with `--terminal` while every sibling uses `--from`, so
// the near-miss ranking answered `--json`/`--run` and left the caller stuck (#16904).
// A synonym only fires where the typed flag is rejected and its partner is accepted.
const FLAG_SYNONYMS: Readonly<Record<string, string>> = { from: 'terminal' }

function suggestFlags(flag: string, validFlags: string[]): string[] {
  const synonym = FLAG_SYNONYMS[flag]
  const scored: { label: string; distance: number }[] = []
  for (const candidate of validFlags) {
    if (Math.abs(flag.length - candidate.length) <= SUGGESTION_THRESHOLD) {
      scored.push({ label: candidate, distance: levenshtein(flag, candidate) })
    }
  }
  const ranked = rankByDistance(scored)
  return synonym && validFlags.includes(synonym)
    ? [synonym, ...ranked.filter((name) => name !== synonym)].slice(0, MAX_SUGGESTIONS)
    : ranked
}

// Why: include the accepted set so agents can recover without another help call.
export function unknownFlagData(flag: string, validFlags: string[]): FlagErrorData {
  const sortedValid = [...validFlags].sort((a, b) => a.localeCompare(b))
  const suggestions = suggestFlags(flag, sortedValid)
  const nextSteps: string[] = []
  if (suggestions.length > 0) {
    nextSteps.push(`Did you mean: ${suggestions.map((name) => `--${name}`).join(', ')}`)
  }
  nextSteps.push(`Valid flags: ${sortedValid.map((name) => `--${name}`).join(', ')}`)
  return { validFlags: sortedValid, suggestions, nextSteps }
}
