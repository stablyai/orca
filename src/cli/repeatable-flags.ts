import { specPaths, type CommandSpec } from './command-spec'

/** NUL can never reach argv, so it cannot collide with a real flag value. */
export const REPEATED_FLAG_SEPARATOR = '\u0000'

type FlagOccurrences = Map<string, (string | boolean)[]>

type FoldableArgs = {
  commandPath: string[]
  flags: Map<string, string | boolean>
  flagOccurrences?: FlagOccurrences
}

/**
 * Parsing cannot know yet which flags repeat, so it keeps every occurrence and
 * still applies last-value-wins; `foldRepeatableFlags` revisits the declared ones
 * once the command is resolved.
 */
export function recordFlagOccurrence(
  flags: Map<string, string | boolean>,
  occurrences: FlagOccurrences,
  name: string,
  value: string | boolean
): void {
  const existing = occurrences.get(name)
  if (existing) {
    existing.push(value)
  } else {
    occurrences.set(name, [value])
  }
  flags.set(name, value)
}

function repeatableFlagsForPath(specs: CommandSpec[], commandPath: string[]): readonly string[] {
  const spec = specs.find((candidate) =>
    specPaths(candidate).some(
      (path) =>
        path.length === commandPath.length &&
        path.every((part, index) => part === commandPath[index])
    )
  )
  return spec?.repeatableFlags ?? []
}

/**
 * Returns the flag map handlers should read: values of flags the resolved command
 * declares repeatable are collected, every other flag keeps last-value-wins.
 */
export function foldRepeatableFlags(
  specs: CommandSpec[],
  parsed: FoldableArgs
): Map<string, string | boolean> {
  const occurrences = parsed.flagOccurrences
  if (!occurrences) {
    return parsed.flags
  }
  const repeatable = repeatableFlagsForPath(specs, parsed.commandPath)
  if (repeatable.length === 0) {
    return parsed.flags
  }
  const flags = new Map(parsed.flags)
  for (const name of repeatable) {
    // Why: a valueless occurrence (`--label` with nothing after it) stays the
    // boolean it parsed as rather than joining an empty entry into the list.
    const values = (occurrences.get(name) ?? []).filter(
      (value): value is string => typeof value === 'string'
    )
    if (values.length > 0) {
      flags.set(name, values.join(REPEATED_FLAG_SEPARATOR))
    }
  }
  return flags
}
