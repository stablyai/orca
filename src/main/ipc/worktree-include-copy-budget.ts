import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Ceiling on what one worktree materialization may copy, measured before any
 *  bytes are written. Both limits are cumulative across the whole run, so a
 *  hundred medium entries trip the same guard one huge entry does. */
export type WorktreeCopyBudget = {
  maxBytes: number
  maxEntries: number
}

// Why: `.worktreeinclude` is a repo-authored list, and a repo that lists
// `node_modules` freezes worktree creation for minutes behind an inline copy
// (macOS gets a cheap APFS clone; Linux/Windows get a full `fs.cp`). These
// limits clear real payloads — `.env` files, `.vscode/`, small build caches —
// and refuse dependency trees. The entry limit matters as much as the byte
// limit: 200k tiny files are slow to copy even though they weigh little.
export const DEFAULT_WORKTREE_COPY_BUDGET: WorktreeCopyBudget = {
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 50_000
}

// Why: the sizing walk gets headroom over the copy budget so one refused
// `node_modules` cannot starve the small entries listed after it — it burns
// maxEntries+1 measuring, and without headroom nothing else would be sized.
const WORKTREE_COPY_SIZING_HEADROOM = 5

export type WorktreeCopyBudgetExceededReason =
  | 'bytes'
  | 'entries'
  /** Not this entry's fault: earlier entries used up the total sizing walk. */
  | 'sizing'

export type WorktreeCopySizeVerdict =
  | { withinBudget: true; bytes: number; entries: number }
  | { withinBudget: false; reason: WorktreeCopyBudgetExceededReason }

export type SkippedWorktreeCopyPath = {
  path: string
  reason: WorktreeCopyBudgetExceededReason
  /** The copy was abandoned after it had started, so leftovers may remain —
   *  "copy it in manually" would then merge into a half-populated directory. */
  mayBePartial?: boolean
}

export type WorktreeCopyAdmitOptions = {
  /** False when the backend clones copy-on-write (APFS `clonefile`), where
   *  bytes cost nothing and only inode count is real work. */
  bytesAreCopied?: boolean
}

export type WorktreeCopyBudgetTracker = {
  /** Measure `source` against what is left of the budget. A `withinBudget`
   *  verdict consumes the measured size; an over-budget verdict consumes
   *  nothing, so later, smaller entries still get their chance.
   *
   *  Await each call before the next: the remaining pool is read before the
   *  measurement walk and written after it, so concurrent callers would both
   *  size against the same stale pool and could jointly bust the budget. */
  admit: (source: string, options?: WorktreeCopyAdmitOptions) => Promise<WorktreeCopySizeVerdict>
  /** Bill bytes that were measured but not charged, because the copy was
   *  expected to clone and then didn't. Returns false if they no longer fit,
   *  in which case the caller must not run the copy. */
  chargeBytes: (bytes: number) => boolean
}

type MeasuredCopySize = {
  verdict: WorktreeCopySizeVerdict
  /** Entries actually walked, whatever the verdict — this is the measurement's
   *  own cost, which the tracker charges so a long list of over-budget entries
   *  cannot re-freeze creation by re-walking for each one. */
  walked: number
}

async function measureCopySize(
  source: string,
  remainingBytes: number,
  remainingEntries: number,
  remainingWalk: number
): Promise<MeasuredCopySize> {
  let bytes = 0
  let entries = 0
  const pending: string[] = [source]
  while (pending.length > 0) {
    const current = pending.pop() as string
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(current)
    } catch {
      // Raced away between the walk and now — the copy will skip it too.
      continue
    }
    entries += 1
    if (entries > Math.min(remainingEntries, remainingWalk)) {
      // Why: attribute to whichever ceiling actually bound. Blaming the file
      // limit for a walk that earlier entries used up would quote the user a
      // limit this entry never approached.
      const reason = remainingWalk < remainingEntries ? 'sizing' : 'entries'
      return { verdict: { withinBudget: false, reason }, walked: entries }
    }
    // Why: both copy backends reproduce a nested symlink as a symlink rather
    // than following it, so walking through one would double-count a shared
    // target and could loop forever on a cycle.
    if (stats.isSymbolicLink()) {
      continue
    }
    if (stats.isDirectory()) {
      try {
        for (const name of await readdir(current)) {
          pending.push(join(current, name))
        }
      } catch {
        // Unreadable directory — nothing measurable, and the copy will report it.
      }
      continue
    }
    bytes += stats.size
    if (bytes > remainingBytes) {
      return { verdict: { withinBudget: false, reason: 'bytes' }, walked: entries }
    }
  }
  return { verdict: { withinBudget: true, bytes, entries }, walked: entries }
}

/** Why a pre-measurement pass rather than aborting mid-copy: `fs.cp` ignores
 *  its `signal` option, so a copy that has started cannot be cancelled and
 *  would leave a partial tree behind. Refusing before the first byte is
 *  written keeps the worktree in a state the user can reason about. The walk
 *  is itself bounded — it returns the moment either limit is crossed. */
export function createWorktreeCopyBudgetTracker(
  budget: WorktreeCopyBudget = DEFAULT_WORKTREE_COPY_BUDGET
): WorktreeCopyBudgetTracker {
  let remainingBytes = budget.maxBytes
  let remainingEntries = budget.maxEntries
  // Why: refused entries consume no copy budget, so without a separate ceiling
  // on walking itself a `.worktreeinclude` listing 1000 over-budget directories
  // would pay a fresh full-limit walk for each one — the very stall this bounds.
  let remainingWalk = budget.maxEntries * WORKTREE_COPY_SIZING_HEADROOM
  return {
    admit: async (source, { bytesAreCopied = true } = {}) => {
      if (remainingWalk <= 0) {
        return { withinBudget: false, reason: 'sizing' }
      }
      const { verdict, walked } = await measureCopySize(
        source,
        bytesAreCopied ? remainingBytes : Number.POSITIVE_INFINITY,
        remainingEntries,
        remainingWalk
      )
      remainingWalk -= walked
      if (verdict.withinBudget) {
        if (bytesAreCopied) {
          remainingBytes -= verdict.bytes
        }
        remainingEntries -= verdict.entries
      }
      return verdict
    },
    chargeBytes: (bytes) => {
      if (bytes > remainingBytes) {
        return false
      }
      remainingBytes -= bytes
      return true
    }
  }
}

function formatByteLimit(maxBytes: number): string {
  const gigabytes = maxBytes / (1024 * 1024 * 1024)
  if (gigabytes >= 1) {
    return `${Number(gigabytes.toFixed(1))} GB`
  }
  return `${Math.max(1, Math.round(maxBytes / (1024 * 1024)))} MB`
}

const MAX_NAMED_SKIPPED_ENTRIES = 5

/** User-facing warning for entries the budget refused. Returns undefined when
 *  nothing was skipped so callers can spread it conditionally. */
export function formatWorktreeIncludeCopyWarning(
  skipped: readonly SkippedWorktreeCopyPath[],
  budget: WorktreeCopyBudget = DEFAULT_WORKTREE_COPY_BUDGET
): string | undefined {
  if (skipped.length === 0) {
    return undefined
  }
  // Why: `.worktreeinclude` allows 1000 entries and every one can be skipped,
  // so enumerating them all would put a multi-kilobyte sentence in a warning.
  const nameList = (entries: readonly SkippedWorktreeCopyPath[]): string => {
    const shown = entries.slice(0, MAX_NAMED_SKIPPED_ENTRIES)
    const names = shown.map((entry) => `"${entry.path}"`).join(', ')
    const rest = entries.length - shown.length
    return rest > 0 ? `${names} and ${rest.toLocaleString('en-US')} more` : names
  }
  const describe = (entries: readonly SkippedWorktreeCopyPath[]): string => {
    const subject = entries.length === 1 ? 'entry' : 'entries'
    const verb = entries.length === 1 ? 'was' : 'were'
    return `.worktreeinclude ${subject} ${nameList(entries)} ${verb} not copied into the new workspace`
  }
  const pronoun = (count: number): string => (count === 1 ? 'it' : 'them')
  // Why: an entry refused because earlier ones exhausted the sizing walk never
  // approached the limits itself, so quoting them at the user would be a lie.
  const overBudget = skipped.filter((entry) => entry.reason !== 'sizing')
  const unsized = skipped.filter((entry) => entry.reason === 'sizing')
  const sentences: string[] = []
  if (overBudget.length > 0) {
    sentences.push(
      `${describe(overBudget)}: copying ${pronoun(overBudget.length)} would exceed the ` +
        `${formatByteLimit(budget.maxBytes)} / ${budget.maxEntries.toLocaleString('en-US')} ` +
        `file limit that keeps workspace creation responsive.`
    )
  }
  const partial = skipped.filter((entry) => entry.mayBePartial)
  if (unsized.length > 0) {
    sentences.push(
      `${describe(unsized)}: earlier entries used up the budget for measuring what to copy.`
    )
  }
  if (partial.length > 0) {
    // Why: the copy was abandoned after it started, so "copy it in manually"
    // would merge into whatever the interrupted run already left behind.
    sentences.push(
      `${nameList(partial)} may hold a partial copy from the interrupted attempt — check ` +
        `${pronoun(partial.length)} before reusing this workspace.`
    )
  }
  sentences.push(
    `Copy ${pronoun(skipped.length)} in manually if this workspace needs ${pronoun(skipped.length)}.`
  )
  return sentences.join(' ')
}
