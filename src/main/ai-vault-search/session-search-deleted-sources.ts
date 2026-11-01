import { basename, dirname } from 'node:path'
import type { SessionSearchDegradedRoot } from './session-search-degraded-roots'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'
import { isUnderScanRoot } from './session-search-scan-roots'
import { splitSyntheticSessionSource } from './session-search-synthetic-sources'
import type { SessionSearchStore } from './session-search-store'

// Walk missing directories upward to seek a listing that proves which component disappeared.
const MISSING_DIRECTORY = new Set(['ENOENT', 'ENOTDIR'])

export type SessionSearchRetirement = {
  retired: string[]
  /** Rows kept: this pass could prove the file neither present nor gone. */
  unverifiable: string[]
  /** Paths the per-pass cap left for next time. */
  unchecked: string[]
  /** Roots owning at least one unverifiable verdict, with the reason. */
  degradedRoots: SessionSearchDegradedRoot[]
}

export type SessionSearchRetirementArgs = {
  store: SessionSearchStore
  /** Indexed paths absent from this pass’s discovery. */
  paths: readonly string[]
  /** Longest containing root bounds each path’s proof walk. */
  roots: readonly string[]
  /** Roots that listed transcripts on the previous pass and none on this one. */
  emptiedRoots?: ReadonlySet<string>
  /** Complete successful container enumerations; see session-search-synthetic-sources.ts. */
  enumeratedContainers?: ReadonlyMap<string, ReadonlySet<string>>
  listings: SessionSearchDirectoryReader
  /** Bound directory work rather than rows so one unreadable directory cannot starve later rows. */
  directoryLimit?: number
  signal?: AbortSignal
}

type SessionSearchSourceVerdict =
  | { verdict: 'gone' }
  | { verdict: 'present' }
  | { verdict: 'unverifiable'; reason: string }

/** Retire only proven absence within configured roots; missing or unreadable roots retain their rows. */
export async function retireDeletedSessionSearchSources(
  args: SessionSearchRetirementArgs
): Promise<SessionSearchRetirement> {
  const { store, paths, signal } = args
  const emptiedRoots = args.emptiedRoots ?? new Set<string>()
  const directoryLimit = args.directoryLimit ?? Number.POSITIVE_INFINITY
  // Count distinct directories, including any already cached by this pass.
  const asked = new Set<string>()
  const listings: SessionSearchDirectoryReader = {
    namesIn: (directory, signal) => {
      asked.add(directory)
      return args.listings.namesIn(directory, signal)
    }
  }
  const retirement: SessionSearchRetirement = {
    retired: [],
    unverifiable: [],
    unchecked: [],
    degradedRoots: []
  }
  const degraded = new Map<string, string>()
  for (const [index, path] of paths.entries()) {
    // Synthetic paths name entries inside containers, not filesystem objects.
    const synthetic = splitSyntheticSessionSource(path)
    const filePath = synthetic?.container ?? path
    // After the budget, finish cached directories so row ordering cannot monopolize the next pass.
    if (signal?.aborted || (asked.size >= directoryLimit && !asked.has(dirname(filePath)))) {
      retirement.unchecked = paths.slice(index)
      break
    }
    const root = configuredRootFor(filePath, args.roots)
    const containerProof = await proveSource(filePath, root ?? dirname(filePath), {
      listings,
      emptiedRoots,
      signal
    })
    const proof = synthetic
      ? proveSyntheticSource(synthetic, containerProof, args.enumeratedContainers)
      : containerProof
    if (proof.verdict === 'gone') {
      store.removeFile(path)
      retirement.retired.push(path)
      continue
    }
    if (proof.verdict === 'present') {
      continue
    }
    retirement.unverifiable.push(path)
    if (root !== null && !degraded.has(root)) {
      degraded.set(root, proof.reason)
    }
  }
  retirement.degradedRoots = [...degraded].map(([root, reason]) => ({ root, reason }))
  return retirement
}

/** Ascend through missing directories, stopping at the configured root or the first listing verdict. */
async function proveSource(
  path: string,
  root: string,
  context: {
    listings: SessionSearchDirectoryReader
    emptiedRoots: ReadonlySet<string>
    signal?: AbortSignal
  }
): Promise<SessionSearchSourceVerdict> {
  let directory = dirname(path)
  let child = basename(path)
  while (directory === root || isUnderScanRoot(directory, root)) {
    const listing = await context.listings.namesIn(directory, context.signal)
    if (!listing.listed) {
      if (listing.code !== null && MISSING_DIRECTORY.has(listing.code)) {
        const parent = dirname(directory)
        if (parent === directory) {
          break
        }
        child = basename(directory)
        directory = parent
        continue
      }
      return { verdict: 'unverifiable', reason: listing.message }
    }
    if (listing.names.has(child)) {
      return { verdict: 'present' }
    }
    if (directory === root && context.emptiedRoots.has(root)) {
      // Give newly empty roots one pass of grace against transient swaps or mount changes.
      return {
        verdict: 'unverifiable',
        reason: 'Listed no transcripts where it listed some on the previous pass.'
      }
    }
    return { verdict: 'gone' }
  }
  return { verdict: 'unverifiable', reason: `${root} could not be listed.` }
}

/** Prove container availability first; only a full enumeration can establish an entry’s absence. */
function proveSyntheticSource(
  synthetic: { container: string; id: string },
  containerProof: SessionSearchSourceVerdict,
  enumerated?: ReadonlyMap<string, ReadonlySet<string>>
): SessionSearchSourceVerdict {
  if (containerProof.verdict !== 'present') {
    return containerProof
  }
  const ids = enumerated?.get(synthetic.container)
  // Unknown schemas can enumerate empty; require nonempty evidence before retiring container entries.
  if (!ids || ids.size === 0) {
    return {
      verdict: 'unverifiable',
      reason: `${synthetic.container} was not enumerated in full this pass.`
    }
  }
  return ids.has(synthetic.id) ? { verdict: 'present' } : { verdict: 'gone' }
}

function configuredRootFor(path: string, roots: readonly string[]): string | null {
  let owner: string | null = null
  for (const root of roots) {
    if (isUnderScanRoot(path, root) && (owner === null || root.length > owner.length)) {
      owner = root
    }
  }
  return owner
}
