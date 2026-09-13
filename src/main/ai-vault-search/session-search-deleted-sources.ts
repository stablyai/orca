import { basename, dirname } from 'node:path'
import type { SessionSearchDegradedRoot } from './session-search-degraded-roots'
import type { SessionSearchDirectoryReader } from './session-search-directory-listings'
import { isUnderScanRoot } from './session-search-scan-roots'
import { splitSyntheticSessionSource } from './session-search-synthetic-sources'
import type { SessionSearchStore } from './session-search-store'

/*
 * Retirement invariants. Every one of these is a test; changing this file means
 * changing the list, not working around it.
 *
 * I1. A row is retired only when its file is PROVEN gone: some directory
 *     between the file and its configured root lists successfully, and the next
 *     path component toward the file is absent from that listing.
 * I2. If no directory from the file's parent up to the configured root can be
 *     listed, nothing is proven and no row is dropped. ENOENT/ENOTDIR is walked
 *     up (the directory itself is a missing component of some ancestor);
 *     EACCES, EIO, a WSL gate refusal, anything else, is unverifiable at once.
 * I3. The rule is the same on the first pass after a process start and on every
 *     later pass. It needs no memory of what previous passes saw, because the
 *     walk is bounded at the configured root and never reasons about what is
 *     above it.
 * I4. A file, or a project directory, the user really deleted retires on the
 *     first pass that proves it. There is no waiting period and no census.
 * I8. A row whose path names an entry inside a container rather than a file of
 *     its own is proven the same way, one level up: the container must be
 *     present, and the pass must have enumerated it in full and successfully.
 *     A listing is a listing whether it comes from readdir or from a database.
 *
 * What I3 costs, stated rather than hidden: a volume mounted at exactly a
 * configured root, unmounted so that the mountpoint stays present and lists
 * empty, is indistinguishable from a root the user emptied. It retires. The
 * realistic unmount shapes do not: a mount above the root leaves the root
 * itself missing (the walk stops at the root boundary), and an unreadable root
 * is an error, not a listing. One bit per root buys the remaining grace: a root
 * that held transcripts on the previous pass and holds none on this one is
 * unverifiable for that pass, so a single flap cannot retire a tree.
 */

// Walked up rather than believed: a directory that ENOENTs is itself the
// missing component its parent has to be asked about.
const MISSING_DIRECTORY = new Set(['ENOENT', 'ENOTDIR'])

export type SessionSearchRetirement = {
  /** Paths proven gone and dropped from the index. */
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
  /** Held paths this pass did not discover; everything else is still there. */
  paths: readonly string[]
  /** The real directories this pass walked; the longest one containing a path bounds its walk. */
  roots: readonly string[]
  /** Roots that listed transcripts on the previous pass and none on this one. */
  emptiedRoots?: ReadonlySet<string>
  /**
   * Containers this pass enumerated in full, with the ids each holds. Only a
   * census builds it; see session-search-synthetic-sources.ts for the bar a
   * container has to meet before it appears here.
   */
  enumeratedContainers?: ReadonlyMap<string, ReadonlySet<string>>
  /** One readdir per directory per pass, shared with the rest of the pass. */
  listings: SessionSearchDirectoryReader
  /**
   * Directories this walk may read before the pass moves on.
   *
   * Directories, not rows. A row whose walk finds its directory already read is
   * answered from the pass's cache and costs nothing, so counting rows made an
   * unreadable directory able to starve the whole walk: five hundred rows under
   * one EACCES directory are one readdir and five hundred identical
   * unverifiable verdicts, and a row for a file the user really deleted, sorted
   * behind them, was never reached on any pass.
   */
  directoryLimit?: number
  signal?: AbortSignal
}

type SessionSearchSourceVerdict =
  | { verdict: 'gone' }
  | { verdict: 'present' }
  | { verdict: 'unverifiable'; reason: string }

/**
 * Retires index rows for sources that are provably gone.
 *
 * One function, called by both the sweep and the cycle, because either one
 * alone deleting a user's history the first time a mount is missing is the bug
 * this feature kept shipping. There is no separate root fence: the walk cannot
 * reach a verdict of `gone` without a successful listing, so an unreadable or
 * missing root produces `unverifiable` structurally rather than by a guard
 * somebody has to remember to call (docs/reference/ssh-execution-boundary.md:
 * loss of contact is never evidence of absence).
 */
export async function retireDeletedSessionSearchSources(
  args: SessionSearchRetirementArgs
): Promise<SessionSearchRetirement> {
  const { store, paths, signal } = args
  const emptiedRoots = args.emptiedRoots ?? new Set<string>()
  const directoryLimit = args.directoryLimit ?? Number.POSITIVE_INFINITY
  // Every directory this walk asked for, whether the pass had already read it
  // or not. What it bounds is real work: a repeat of one already in here is a
  // map lookup, and only a name that is new to it can cost a readdir.
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
    // A synthetic row names a container and an entry inside it, never a file of
    // its own; walking the row's own path would report every one of them gone.
    const synthetic = splitSyntheticSessionSource(path)
    const filePath = synthetic?.container ?? path
    // Why capped at all: the sweep hands over every path it holds and did not
    // discover, and under an unmount that is the whole index. What is left is
    // simply still undiscovered next pass, so the walk finishes over the ones
    // that follow rather than holding this one.
    //
    // Spent past the bound only by a row that starts somewhere new. One this
    // walk has already read is answered from the map, so refusing it would buy
    // nothing and would leave the budget hostage to whichever directory the
    // rows happened to be sorted by.
    if (signal?.aborted || (asked.size >= directoryLimit && !asked.has(dirname(filePath)))) {
      retirement.unchecked.push(...paths.slice(index))
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
    // Only a configured root is an alarm worth raising: a row under no root
    // this scan walks is already reported on its own, as an orphan.
    if (root !== null && !degraded.has(root)) {
      degraded.set(root, proof.reason)
    }
  }
  retirement.degradedRoots = [...degraded].map(([root, reason]) => ({ root, reason }))
  return retirement
}

/**
 * Walks from the file toward its configured root, asking each directory whether
 * the next component toward the file is there. The first directory that answers
 * decides; a directory that is itself missing moves the question up one level.
 *
 * The loop cannot pass the configured root, which is what makes the whole thing
 * memoryless: everything above the root — a home directory on an unmounted
 * volume, a detached drive, an SSH mount that is not there — is out of scope by
 * construction rather than by a state machine that has to remember it.
 */
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
      // One pass of grace, so a root that blinks empty for a moment — a sync
      // client mid-swap, a mount that has not settled — cannot retire a tree.
      return {
        verdict: 'unverifiable',
        reason: 'Listed no transcripts where it listed some on the previous pass.'
      }
    }
    return { verdict: 'gone' }
  }
  return { verdict: 'unverifiable', reason: `${root} could not be listed.` }
}

/**
 * A synthetic row is proven by its container's own enumeration, one level above
 * where the filesystem walk stops.
 *
 * The container has to be present first: a database on a volume that is not
 * there proves nothing about the sessions inside it, and a database that is
 * gone takes its sessions with it. Only then does the enumeration decide, and
 * only when this pass made one that was exhaustive and successful -- a cycle
 * asks for the newest N per agent, so an id it did not return may just be the
 * one after them.
 */
function proveSyntheticSource(
  synthetic: { container: string; id: string },
  containerProof: SessionSearchSourceVerdict,
  enumerated?: ReadonlyMap<string, ReadonlySet<string>>
): SessionSearchSourceVerdict {
  if (containerProof.verdict !== 'present') {
    return containerProof
  }
  const ids = enumerated?.get(synthetic.container)
  // An enumeration that returned nothing at all is not evidence that the
  // container holds nothing: a source whose schema this scanner no longer
  // recognises reads as empty with no error to see, and believing it would
  // retire every entry in one pass.
  if (!ids || ids.size === 0) {
    return {
      verdict: 'unverifiable',
      reason: `${synthetic.container} was not enumerated in full this pass.`
    }
  }
  return ids.has(synthetic.id) ? { verdict: 'present' } : { verdict: 'gone' }
}

/** Longest configured root containing the path, or null for a row under none. */
function configuredRootFor(path: string, roots: readonly string[]): string | null {
  let owner: string | null = null
  for (const root of roots) {
    if (isUnderScanRoot(path, root) && (owner === null || root.length > owner.length)) {
      owner = root
    }
  }
  return owner
}
