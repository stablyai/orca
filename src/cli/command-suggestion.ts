import { specPaths, type CommandSpec } from './command-spec'
import { levenshtein } from '../shared/edit-distance'

const SUGGESTION_THRESHOLD = 3
const MAX_SUGGESTIONS = 3

// Distance 1 recovers remov→remove without suggesting deletion for move.
const DESTRUCTIVE_INTENT_THRESHOLD = 1

function finalToken(path: string[]): string {
  return path.at(-1) ?? ''
}

// Aliases join destructive verb families without admitting unrelated verbs.
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

function rankByDistance(scored: { label: string; distance: number }[]): string[] {
  return scored
    .filter((entry) => entry.distance > 0 && entry.distance <= SUGGESTION_THRESHOLD)
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.label)
}

// Match depth to avoid suggesting parent groups or unrelated commands.
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

// Recover renamed flags only when the typed flag is rejected and its synonym is accepted.
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
