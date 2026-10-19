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

// Why: declared aliases connect equivalent destructive verbs without unlocking unrelated actions.
function destructiveVerbFamilies(specs: CommandSpec[]): Map<string, Set<string>> {
  const families = new Map<string, Set<string>>()
  for (const spec of specs) {
    if (!spec.destructive) {
      continue
    }
    const verbs = specPaths(spec).map(finalToken)
    const family = new Set(verbs.flatMap((verb) => [...(families.get(verb) ?? [verb])]))
    for (const verb of family) {
      families.set(verb, family)
    }
  }
  return families
}

function intendsDestruction(inputToken: string, verbs: Set<string> | undefined): boolean {
  for (const verb of verbs ?? []) {
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
    .filter((entry) => entry.distance > 0 && entry.distance <= SUGGESTION_THRESHOLD)
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.label)
}

// Why: same-depth matching avoids suggesting parent groups or unrelated commands.
export function suggestCommands(specs: CommandSpec[], commandPath: string[]): string[] {
  const input = commandPath.join(' ')
  const families = destructiveVerbFamilies(specs)
  const seen = new Set<string>()
  const scored: { label: string; distance: number }[] = []
  for (const spec of specs) {
    if (spec.hidden) {
      continue
    }
    if (
      spec.destructive &&
      !intendsDestruction(finalToken(commandPath), families.get(finalToken(spec.path)))
    ) {
      continue
    }
    const candidates = specPaths(spec).map((path) =>
      commandPath.length === 1 ? path.slice(0, 1) : path
    )
    for (const candidate of candidates) {
      if (candidate.length !== commandPath.length) {
        continue
      }
      const joined = candidate.join(' ')
      if (seen.has(joined)) {
        continue
      }
      seen.add(joined)
      if (Math.abs(input.length - joined.length) <= SUGGESTION_THRESHOLD) {
        scored.push({ label: joined, distance: levenshtein(input, joined) })
      }
    }
  }
  return rankByDistance(scored)
}

export function unknownCommandData(specs: CommandSpec[], commandPath: string[]): CommandErrorData {
  const suggestions = suggestCommands(specs, commandPath)
  const nextSteps = suggestions.length
    ? [`Did you mean: ${suggestions.map((path) => `orca ${path}`).join(', ')}`]
    : []
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
