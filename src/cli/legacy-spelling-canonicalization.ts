import { CLI_FLAG_ALIASES } from '../shared/cli-argument-boundary'
import type { CommandSpec } from './command-spec'

type ParsedFlags = {
  commandPath: string[]
  flags: Map<string, string | boolean>
  flagAliasConflicts?: { flag: string; alias: string }[]
}

function matches(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

/** Raw argv with old flag spellings renamed, so commands rebuilt from argv print only canonical flags. */
export function canonicalizeLegacyFlagArgv(argv: readonly string[]): string[] {
  const end = argv.indexOf('--')
  return argv.map((token, index) => {
    if ((end !== -1 && index >= end) || !token.startsWith('--')) {
      return token
    }
    const [name, ...value] = token.slice(2).split('=')
    const canonical = CLI_FLAG_ALIASES[name]
    return canonical === undefined ? token : [`--${canonical}`, ...value].join('=')
  })
}

/** Renames old flag spellings so every later reader sees only canonical flags. */
export function canonicalizeFlagAliases<Parsed extends ParsedFlags>(parsed: Parsed): Parsed {
  if (!Object.keys(CLI_FLAG_ALIASES).some((alias) => parsed.flags.has(alias))) {
    return parsed
  }
  const flags = new Map<string, string | boolean>()
  const conflicts: { flag: string; alias: string }[] = []
  for (const [name, value] of parsed.flags) {
    const canonical = CLI_FLAG_ALIASES[name]
    if (canonical === undefined) {
      flags.set(name, value)
    } else if (!parsed.flags.has(canonical)) {
      flags.set(canonical, value)
    } else if (parsed.flags.get(canonical) !== value) {
      conflicts.push({ flag: canonical, alias: name })
    }
  }
  return {
    ...parsed,
    flags,
    ...(conflicts.length > 0 ? { flagAliasConflicts: conflicts } : {})
  }
}

/**
 * A group typed under an alias (`orca environment`, or `orca environment stp`) names the canonical
 * group (`orca server`), so help, errors and suggestions print only canonical words.
 */
export function canonicalizeGroupAlias(specs: CommandSpec[], path: string[]): string[] {
  for (let length = path.length; length > 0; length -= 1) {
    const prefix = path.slice(0, length)
    if (isCanonicalPrefix(specs, prefix)) {
      return path
    }
    for (const spec of specs) {
      for (const alias of [...(spec.aliases ?? []), ...(spec.legacyAliases ?? [])]) {
        if (alias.length > length && matches(alias.slice(0, length), prefix)) {
          return [...spec.path.slice(0, length), ...path.slice(length)]
        }
      }
    }
  }
  return path
}

function isCanonicalPrefix(specs: CommandSpec[], path: string[]): boolean {
  return specs.some(
    (spec) => spec.path.length >= path.length && matches(spec.path.slice(0, path.length), path)
  )
}
