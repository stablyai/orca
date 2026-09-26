import { globSync, opendirSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { PathApi } from './ssh-config-include-path-resolution'

const GLOB_METACHARACTER = /[*?[]/
// Alias checks run on the main process, so uncertainty is safer than an unbounded proof scan.
// Paths are the expensive axis: each one is an open on a filesystem that may be a network mount.
const MAX_GLOB_READABILITY_PATHS = 256
// Entries are batched reads inside a directory that is already open, so they get their own, far
// larger allowance. A ~/.ssh holding hundreds of keys and control sockets is ordinary, and charging
// its entries against the path budget reported a perfectly readable directory as unopenable.
const MAX_GLOB_READABILITY_ENTRIES = 16_384
const GLOB_READABILITY_LIMIT_REACHED = Symbol('glob-readability-limit-reached')

/**
 * Why a glob could not be proven complete. Both block a confident alias claim, but they are not the
 * same problem and must not be reported as each other: one is a permission or I/O fault the user can
 * fix, the other is a readable tree that is simply too big to walk on the main process.
 */
export type GlobUncertaintyReason = 'unreadable' | 'unproven-within-budget'

export type GlobExpansionUncertainty = {
  /** The directory that could not be walked, or the pattern when its own traversal ran out. */
  target: string
  reason: GlobUncertaintyReason
}

/**
 * Per-expansion memo of directories already walked, keyed by path, so sibling Includes under one
 * parent (`Include conf.d/a*` plus `Include conf.d/b*`) enumerate that parent once.
 *
 * Only definitive verdicts are stored. Budget exhaustion is not one: it depends on what the calling
 * scan had left, so another scan may still prove the same directory.
 */
export type GlobReadabilityProofs = Map<string, GlobExpansionUncertainty | null>

export type GlobReadabilityScanOptions = {
  maxEntries?: number
  maxPaths?: number
  proofs?: GlobReadabilityProofs
}

type ScanBudget = {
  entries: number
  paths: number
  proofs: GlobReadabilityProofs
}

export function createGlobReadabilityProofs(): GlobReadabilityProofs {
  return new Map()
}

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
 * What prevents proving a glob complete, or `null` when every traversed directory was enumerated.
 *
 * `globSync` reports what it could see and never reports what it could not: an unreadable directory
 * yields fewer matches, not an error. Walk each globbed directory level so partial matches are not
 * mistaken for a complete result.
 */
export function findGlobExpansionUncertainty(
  pattern: string,
  pathApi: PathApi,
  options: GlobReadabilityScanOptions = {}
): GlobExpansionUncertainty | null {
  const budget: ScanBudget = {
    entries: options.maxEntries ?? MAX_GLOB_READABILITY_ENTRIES,
    paths: options.maxPaths ?? MAX_GLOB_READABILITY_PATHS,
    proofs: options.proofs ?? createGlobReadabilityProofs()
  }
  const unwalkableParent = findUnwalkableDirectory(getLiteralGlobParent(pattern, pathApi), budget)
  if (unwalkableParent) {
    return unwalkableParent
  }
  for (const prefix of getGlobDirectoryPrefixes(pattern, pathApi)) {
    const directories = globWithinReadabilityLimit(prefix, budget)
    if (directories === null) {
      return { reason: 'unproven-within-budget', target: pattern }
    }
    for (const directory of directories) {
      const unwalkable = findUnwalkableDirectory(directory, budget)
      if (unwalkable) {
        return unwalkable
      }
    }
  }
  return null
}

/** Missing directories and paths below regular files are definitive empty matches. */
function findUnwalkableDirectory(
  directory: string,
  budget: ScanBudget
): GlobExpansionUncertainty | null {
  if (budget.proofs.has(directory)) {
    return budget.proofs.get(directory) ?? null
  }
  if (budget.paths <= 0) {
    return { reason: 'unproven-within-budget', target: directory }
  }
  budget.paths -= 1

  try {
    // Read every entry: some network filesystems open successfully but fail during enumeration.
    const handle = opendirSync(directory)
    try {
      while (handle.readSync() !== null) {
        // Exhaust the directory so a late enumeration error cannot look like a complete glob.
        budget.entries -= 1
        if (budget.entries < 0) {
          // Readable so far, just bigger than one scan may walk: unproven, and not memoisable.
          return { reason: 'unproven-within-budget', target: directory }
        }
      }
    } finally {
      handle.closeSync()
    }
    budget.proofs.set(directory, null)
    return null
  } catch (error) {
    const verdict: GlobExpansionUncertainty | null = isDefinitiveAbsence(error)
      ? null
      : { reason: 'unreadable', target: directory }
    budget.proofs.set(directory, verdict)
    return verdict
  }
}

/** Stop a proof scan before a broad glob can synchronously walk an unbounded tree. */
function globWithinReadabilityLimit(pattern: string, budget: ScanBudget): string[] | null {
  try {
    return globSync(pattern, {
      exclude: () => {
        budget.paths -= 1
        if (budget.paths < 0) {
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
