import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { runCoalescedProbe, type CoalescedProbes } from '../../remotes/coalesced-probe'
import type { WorktreeDiffStamp } from './worktree-diff-stamp'

// A dead home or network mount can stall stat; skip reuse after this instead of stalling the poll.
const STAMP_DEADLINE_MS = 2_000

export type StampProbes = CoalescedProbes<WorktreeDiffStamp | null>

/** Null past the deadline; a stat still hung from an earlier poll fails fast instead of piling up. */
export async function readStampWithinDeadline(
  probes: StampProbes,
  key: string,
  readStamp: () => Promise<WorktreeDiffStamp | null>
): Promise<WorktreeDiffStamp | null> {
  const pending = probes.get(key)
  if (pending && Date.now() - pending.startedAt >= STAMP_DEADLINE_MS) {
    return null
  }
  return withTimeout(runCoalescedProbe(probes, key, readStamp), STAMP_DEADLINE_MS, null)
}
