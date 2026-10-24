import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Cumulative materialization limits measured before copying; many medium entries share one budget. */
export type WorktreeCopyBudget = {
  maxBytes: number
  maxEntries: number
}

// Repo-authored include lists can stall creation on huge trees; cap both bytes and costly tiny-file counts.
export const DEFAULT_WORKTREE_COPY_BUDGET: WorktreeCopyBudget = {
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 50_000
}

// Sizing headroom lets later small entries survive measurement of a refused dependency tree.
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
  /** Interrupted directory copies may leave partial contents; warnings must not suggest blindly merging into them. */
  mayBePartial?: boolean
}

export type WorktreeCopyAdmitOptions = {
  /** Copy-on-write skips byte charges while retaining entry-count limits. */
  bytesAreCopied?: boolean
}

export type WorktreeCopyBudgetTracker = {
  /** Await admissions sequentially: each measures against then consumes the remaining budget; refused copies consume none. */
  admit: (source: string, options?: WorktreeCopyAdmitOptions) => Promise<WorktreeCopySizeVerdict>
  /** Charge bytes if a predicted clone needs real copying; false forbids that fallback. */
  chargeBytes: (bytes: number) => boolean
}

type MeasuredCopySize = {
  verdict: WorktreeCopySizeVerdict
  /** Sizing cost is charged even for refused entries so repeated oversize paths cannot stall creation. */
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
      // Report sizing exhaustion separately from a copy limit this entry never approached.
      const reason = remainingWalk < remainingEntries ? 'sizing' : 'entries'
      return { verdict: { withinBudget: false, reason }, walked: entries }
    }
    // Backends copy nested symlinks themselves; following targets would double-count or loop.
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

/** Measure before copying: fs.cp cannot be cancelled, and mid-copy refusal would strand partial trees. */
export function createWorktreeCopyBudgetTracker(
  budget: WorktreeCopyBudget = DEFAULT_WORKTREE_COPY_BUDGET
): WorktreeCopyBudgetTracker {
  let remainingBytes = budget.maxBytes
  let remainingEntries = budget.maxEntries
  // Bound sizing independently: refused copies consume no copy budget but still cost filesystem traversal.
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

export function formatWorktreeIncludeCopyWarning(
  skipped: readonly SkippedWorktreeCopyPath[],
  budget: WorktreeCopyBudget = DEFAULT_WORKTREE_COPY_BUDGET
): string | undefined {
  if (skipped.length === 0) {
    return undefined
  }
  // Bound warning names even when all 1000 allowed include entries are refused.
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
  // Earlier sizing exhaustion proves nothing about this entry's copy size; do not quote those limits.
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
    // Interrupted directory copies need inspection before manual copying merges into leftover content.
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
