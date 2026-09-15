import { globSync, opendirSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { PathApi } from './ssh-config-include-path-resolution'

const GLOB_METACHARACTER = /[*?[]/
// Alias checks run on the main process, so uncertainty is safer than an unbounded proof scan.
const MAX_GLOB_READABILITY_PATHS = 256
const GLOB_READABILITY_LIMIT_REACHED = Symbol('glob-readability-limit-reached')

export function hasGlobPattern(input: string): boolean {
  return GLOB_METACHARACTER.test(input)
}

/** The deepest literal directory that a glob must be able to read. */
export function getLiteralGlobParent(pattern: string, pathApi: PathApi): string {
  const firstGlob = pattern.search(GLOB_METACHARACTER)
  const literal = firstGlob === -1 ? pattern : pattern.slice(0, firstGlob)
  // Appending a filename keeps a prefix ending in a separator from stepping up a directory.
  return pathApi.dirname(`${literal}x`)
}

/**
 * The path that prevents proving a glob complete, or `null` when every traversed directory was
 * enumerated. A proof that exceeds its path budget returns the pattern itself as the uncertainty.
 *
 * `globSync` reports what it could see and never reports what it could not: an unreadable directory
 * yields fewer matches, not an error. Walk each globbed directory level so partial matches are not
 * mistaken for a complete result.
 */
export function findGlobExpansionUncertainty(
  pattern: string,
  pathApi: PathApi,
  maxPaths = MAX_GLOB_READABILITY_PATHS
): string | null {
  const budget = { remaining: maxPaths }
  const unopenableParent = findUnopenableDirectory(getLiteralGlobParent(pattern, pathApi), budget)
  if (unopenableParent) {
    return unopenableParent
  }
  for (const prefix of getGlobDirectoryPrefixes(pattern, pathApi)) {
    const directories = globWithinReadabilityLimit(prefix, budget)
    if (directories === null) {
      return pattern
    }
    for (const directory of directories) {
      const unopenable = findUnopenableDirectory(directory, budget)
      if (unopenable) {
        return unopenable
      }
    }
  }
  return null
}

/** Missing directories and paths below regular files are definitive empty matches. */
function findUnopenableDirectory(directory: string, budget: { remaining: number }): string | null {
  try {
    // Read every entry: some network filesystems open successfully but fail during enumeration.
    const handle = opendirSync(directory)
    try {
      while (handle.readSync() !== null) {
        // Exhaust the directory so a late enumeration error cannot look like a complete glob.
        budget.remaining -= 1
        if (budget.remaining < 0) {
          // Entries share the scan budget: an unbounded directory stays unproven, not blocking.
          return directory
        }
      }
    } finally {
      handle.closeSync()
    }
    return null
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : directory
  }
}

/** Stop a proof scan before a broad glob can synchronously walk an unbounded tree. */
function globWithinReadabilityLimit(
  pattern: string,
  budget: { remaining: number }
): string[] | null {
  try {
    return globSync(pattern, {
      exclude: () => {
        budget.remaining -= 1
        if (budget.remaining < 0) {
          throw GLOB_READABILITY_LIMIT_REACHED
        }
        return false
      }
    })
  } catch (error) {
    if (error === GLOB_READABILITY_LIMIT_REACHED) {
      return null
    }
    throw error
  }
}

/** Glob patterns for each directory level before the final match segment. */
function getGlobDirectoryPrefixes(pattern: string, pathApi: PathApi): string[] {
  const firstGlob = pattern.search(GLOB_METACHARACTER)
  if (firstGlob === -1) {
    return []
  }
  // Windows accepts both separators, and ssh_config is routinely written with forward slashes.
  const isSeparator = (char: string | undefined): boolean =>
    char === '/' || (pathApi.sep === '\\' && char === '\\')
  const prefixes: string[] = []
  for (let index = firstGlob + 1; index < pattern.length; index += 1) {
    if (isSeparator(pattern[index])) {
      prefixes.push(pattern.slice(0, index))
    }
  }
  return prefixes
}
