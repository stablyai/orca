import type { CommandSpec } from './args'
import { specPaths } from './args'

// Why: an unknown command is a dead end for an agent unless the error names the
// real command. Suggestions are ranked by edit distance over the actual command
// registry (canonical paths plus aliases), so they never drift from reality.

const SUGGESTION_THRESHOLD = 3
const MAX_SUGGESTIONS = 3

export type CommandErrorData = {
  suggestions: string[]
  nextSteps: string[]
}

export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) {
    return n
  }
  if (n === 0) {
    return m
  }
  let prev = Array.from({ length: n + 1 }, (_, index) => index)
  let curr = Array.from({ length: n + 1 }, () => 0)
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n]
}

// Why: keep only near matches (within the edit-distance threshold, excluding the
// exact input), closest first, capped — the shared ranking for both command and
// flag suggestions.
function rankByDistance(scored: { label: string; distance: number }[]): string[] {
  return scored
    .filter((entry) => entry.distance > 0 && entry.distance <= SUGGESTION_THRESHOLD)
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.label)
}

// Why: only compare against commands of the same depth (segment count). A typo is
// almost always in one segment, not a missing/extra one, and same-depth matching
// avoids suggesting a parent group or an unrelated longer command.
export function suggestCommands(specs: CommandSpec[], commandPath: string[]): string[] {
  const input = commandPath.join(' ')
  const seen = new Set<string>()
  const scored: { label: string; distance: number }[] = []
  for (const spec of specs) {
    for (const candidate of specPaths(spec)) {
      if (candidate.length !== commandPath.length) {
        continue
      }
      const joined = candidate.join(' ')
      if (seen.has(joined)) {
        continue
      }
      seen.add(joined)
      scored.push({ label: joined, distance: levenshtein(input, joined) })
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

function suggestFlags(flag: string, validFlags: string[]): string[] {
  return rankByDistance(
    validFlags.map((candidate) => ({ label: candidate, distance: levenshtein(flag, candidate) }))
  )
}

// Why: a rejected flag should tell the agent what the command DOES accept, so it
// can correct without a separate `--help` round-trip. `validFlags` is the exact
// set validation accepts (command flags, globals, and the conditional --page).
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
