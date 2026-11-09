import { specPaths, type CommandSpec } from './command-spec'
import { levenshtein } from '../shared/edit-distance'
import { isTerminalHandle } from '../shared/terminal-handle-prefix'

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
    const canonical = (commandPath.length === 1 ? spec.path.slice(0, 1) : spec.path).join(' ')
    const legacy = new Set((spec.legacyAliases ?? []).map((path) => path.join(' ')))
    for (const path of specPaths(spec)) {
      const candidate = commandPath.length === 1 ? path.slice(0, 1) : path
      if (candidate.length !== commandPath.length) {
        continue
      }
      const joined = candidate.join(' ')
      // Legacy spellings are input only: match on them, but suggest the canonical path.
      const label = legacy.has(path.join(' ')) ? canonical : joined
      if (seen.has(joined)) {
        continue
      }
      seen.add(joined)
      if (Math.abs(input.length - joined.length) <= SUGGESTION_THRESHOLD) {
        scored.push({ label, distance: levenshtein(input, joined) })
      }
    }
  }
  return rankByDistance(bestPerLabel(scored))
}

// A legacy alias and its canonical path can share a label; keep the closer match.
function bestPerLabel(
  scored: { label: string; distance: number }[]
): { label: string; distance: number }[] {
  const best = new Map<string, number>()
  for (const { label, distance } of scored) {
    best.set(label, Math.min(distance, best.get(label) ?? distance))
  }
  return [...best].map(([label, distance]) => ({ label, distance }))
}

// A positional terminal handle lands in the command path; point at the flag form instead.
function terminalFlagSuggestion(specs: CommandSpec[], commandPath: string[]): string[] {
  const handleIndex = commandPath.findIndex(isTerminalHandle)
  if (handleIndex < 1) {
    return []
  }
  const parent = commandPath.slice(0, handleIndex).join(' ')
  const spec = specs.find(
    (candidate) =>
      !candidate.hidden && specPaths(candidate).some((path) => path.join(' ') === parent)
  )
  return spec?.allowedFlags.includes('terminal') && spec.identityFlagRoles?.terminal !== 'caller'
    ? [`${spec.path.join(' ')} --terminal <handle>`]
    : []
}

export function unknownCommandData(specs: CommandSpec[], commandPath: string[]): CommandErrorData {
  const suggestions = [
    ...terminalFlagSuggestion(specs, commandPath),
    ...suggestCommands(specs, commandPath)
  ].slice(0, MAX_SUGGESTIONS)
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
const FLAG_SYNONYMS: Readonly<Record<string, string>> = { from: 'terminal', host: 'server' }

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
