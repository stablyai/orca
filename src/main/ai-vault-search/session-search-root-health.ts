import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import type { SessionSearchRootListing } from './session-search-scan-roots'

/** A scan root the index could not read, and what stopped it. */
export type SessionSearchDegradedRoot = { root: string; reason: string }

/** What the last full sweeps saw of one root, carried between passes. */
export type SessionSearchRootState = {
  /** Transcripts it listed when it was last seen holding any. */
  lastHealthyCount: number
  /** Consecutive full sweeps that listed it, successfully, as empty. */
  emptySweeps: number
}

export type SessionSearchRootHealth = {
  degraded: SessionSearchDegradedRoot[]
  /** Carried forward; only a census writes it. */
  states: Map<string, SessionSearchRootState>
}

// Why the indexer probes at all: the file walker swallows a readdir failure and
// returns, so an EACCES root and an agent that was never installed both arrive
// as "no files". Reporting the first as an empty index would be the
// loss-of-contact-as-absence mistake docs/reference/ssh-execution-boundary.md
// forbids, so an empty root is re-checked.
const MISSING_ROOT = new Set(['ENOENT', 'ENOTDIR'])

/** What a probe of an empty root found. `missing` is not yet a verdict. */
type RootProbe = { listed: true } | { listed: false; missing: boolean; reason: string }

/** How many consecutive listable-but-empty sweeps mean the user emptied it. */
const EMPTY_SWEEPS_BEFORE_TRUSTED = 2

/**
 * Classifies the roots a pass walked. Only roots that listed nothing are
 * probed: one that returned files is readable by construction.
 *
 * The rule an empty root is judged by, and why it takes two sweeps:
 *
 * - Cannot be listed: degraded, keeping its last healthy count. An unmounted
 *   SSH home or a detached drive is not an emptied one, and its transcripts
 *   must not be retired on the errors every path under it answers at once.
 * - Missing entirely, while the index holds files under it: also degraded. A
 *   detached volume answers ENOENT, and so does an agent that was never
 *   installed; what tells them apart is whether this index ever indexed
 *   anything there. That evidence is read from the store rather than from
 *   memory, because memory is empty on the first sweep after every restart,
 *   which is precisely when a volume is most likely to be missing.
 * - Missing with nothing held under it: absent, and no concern of ours.
 * - Lists successfully but empty, having held transcripts before: degraded for
 *   now. This is what a freshly unmounted volume also looks like, and one sweep
 *   cannot tell the two apart. "Held before" is read from the store here too,
 *   because an unmount on Linux, WSL or sshfs leaves the mountpoint present and
 *   empty rather than missing, so this is the branch it takes there.
 * - Lists successfully but empty on two consecutive full sweeps: the user
 *   really did delete them. Degraded clears and the rows retire. Without this
 *   the alarm never releases, so a legitimately emptied root pins the whole
 *   index at `degraded` for the life of the process.
 *
 * Consecutive means consecutive: anything that is not a successful empty
 * listing resets the tally, or an empty sweep either side of an unreadable one
 * would add up to a deletion nobody performed.
 *
 * Only a full sweep counts toward that tally. A recent-window cycle can see a
 * root that went to zero, but it is not a census and must not conclude one.
 */
export async function sessionSearchRootHealth(args: {
  listings: readonly SessionSearchRootListing[]
  issues: readonly AiVaultScanIssue[]
  previous: ReadonlyMap<string, SessionSearchRootState>
  /** True for a full sweep, whose observation is allowed to move the tally. */
  census: boolean
  /** Whether the index holds anything under a root, read from the store. */
  holdsFiles: (root: string) => boolean
  signal?: AbortSignal
}): Promise<SessionSearchRootHealth> {
  const degraded = new Map<string, string>()
  const states = new Map(args.previous)
  for (const issue of args.issues) {
    if (issue.kind !== 'notice' && args.listings.some((one) => one.root === issue.path)) {
      degraded.set(issue.path, issue.message)
    }
  }
  for (const listing of args.listings) {
    const previous = args.previous.get(listing.root) ?? { lastHealthyCount: 0, emptySweeps: 0 }
    if (listing.files > 0) {
      states.set(listing.root, { lastHealthyCount: listing.files, emptySweeps: 0 })
      continue
    }
    if (degraded.has(listing.root) || args.signal?.aborted) {
      continue
    }
    const probe = await probeRoot(listing.root, args.signal)
    if (!probe.listed) {
      if (probe.missing && !args.holdsFiles(listing.root)) {
        // Never held anything here: an agent that is not installed.
        continue
      }
      degraded.set(listing.root, probe.reason)
      // Not a successful empty listing, so it breaks the run.
      states.set(listing.root, { ...previous, emptySweeps: 0 })
      continue
    }
    // Listable and empty. The tally only advances on a census, so a cycle reads
    // the sweep's count without ever concluding a root was emptied.
    const emptySweeps = previous.emptySweeps + (args.census ? 1 : 0)
    if (args.census) {
      states.set(listing.root, { ...previous, emptySweeps })
    }
    // The store, not just memory. An unmount on Linux, WSL or sshfs leaves the
    // mountpoint present and empty rather than missing, so this is the branch a
    // detached volume takes there — and on the first sweep of a process, memory
    // has never seen the root healthy.
    const heldBefore = previous.lastHealthyCount > 0 || args.holdsFiles(listing.root)
    if (heldBefore && emptySweeps < EMPTY_SWEEPS_BEFORE_TRUSTED) {
      degraded.set(
        listing.root,
        `Listed no transcripts where it listed ${previous.lastHealthyCount} before.`
      )
      continue
    }
    if (args.census && heldBefore && emptySweeps >= EMPTY_SWEEPS_BEFORE_TRUSTED) {
      // Believed: stop carrying a healthy count that is no longer true.
      states.set(listing.root, { lastHealthyCount: 0, emptySweeps })
    }
  }
  return { degraded: [...degraded].map(([root, reason]) => ({ root, reason })), states }
}

async function probeRoot(root: string, signal?: AbortSignal): Promise<RootProbe> {
  try {
    await wslGatedReaddir(root, 'scan', signal)
    return { listed: true }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null
    return {
      listed: false,
      missing: code !== null && MISSING_ROOT.has(code),
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

/** True when a path lives under a root this pass could not trust. */
export function underDegradedRoot(
  path: string,
  degradedRoots: readonly SessionSearchDegradedRoot[]
): boolean {
  // Both separators: discovery joins with the platform's, and a root can arrive
  // from a config value written with the other one.
  return degradedRoots.some(
    (degraded) =>
      path === degraded.root ||
      path.startsWith(`${degraded.root}/`) ||
      path.startsWith(`${degraded.root}\\`)
  )
}
