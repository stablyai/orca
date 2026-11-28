// A wake holds its owner only while the provider may still be resuming it. Claude does not run an
// owner again when its surviving descendants end, so an unbounded wake left the row working for good.

import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { DecodedClaudeTask, EndedClaudeTask } from './claude-child-work-evidence'

/** Long enough for a resumed owner's first frame, short enough that a wrong guess settles quickly. */
export const CLAUDE_CHILD_WAKE_LEASE_MS = 60_000

/** `at` is on the monotonic clock, so a wall-clock correction cannot stretch or shorten a lease. */
type Wake = { at: number; owner: EndedClaudeTask }

const monotonicNow = (): number => performance.now()

/** What a wake reaches back into the decoder to undo or confirm. */
export type ClaudeChildWakeHost = {
  /** The ending a wake guesses past, when this owner is a finished agent a task can wake. */
  endedOwner(id: string): EndedClaudeTask | undefined
  /** Show the owner working again while the guess holds. */
  showWorking(id: string, task: DecodedClaudeTask): void
  /** The guess was wrong: put the owner back to the ending it guessed past. */
  restore(id: string, owner: EndedClaudeTask): void
  /** The provider confirmed the owner running, so it is live again and must be re-admitted. */
  revive(id: string, runningFrame: Record<string, unknown>): void
}

/** Wakes by owner id, each with the moment it stops guessing, and the ones already spent. */
export class ClaudeChildWake {
  /** In deadline order: every lease is the same length on a clock that never goes back, and a
   *  re-wake moves to the end, so the first entry is always the next to expire. */
  private readonly wakes = new Map<string, Wake>()
  /** Owners whose wake ran out, so a later confirmed running report can still restore them. */
  private readonly expired = new Set<string>()

  constructor(
    private readonly host: ClaudeChildWakeHost,
    private readonly now: () => number = monotonicNow
  ) {}

  /** A child's ending wakes the subagent it was launched from, showing it working from that frame, not a restart. */
  fromEnding(
    toolUseId: string | undefined,
    ownerOf: ((id: string) => string | null) | undefined,
    parentTaskId?: string
  ): void {
    const ownerId = parentTaskId ?? (toolUseId ? ownerOf?.(toolUseId) : null)
    if (ownerId) {
      this.owner(ownerId)
    }
  }

  /** Claude resumes a finished subagent when a task it launched notifies; show it working from that frame, not its restart a moment later. */
  owner(ownerId: string): void {
    const owner = this.host.endedOwner(ownerId)
    if (owner?.outcome !== 'succeeded' || owner.task?.kind !== 'agent') {
      return
    }
    this.host.showWorking(ownerId, owner.task)
    // Why: Claude does not resume an owner whose remaining descendants end later (or one whose
    // worktree is gone), so the guess must expire or the row stays working until the chat closes.
    this.wakes.delete(ownerId)
    this.wakes.set(ownerId, { at: this.now() + CLAUDE_CHILD_WAKE_LEASE_MS, owner })
  }

  /** The provider says this owner runs: the guess was right, or an expired wake is undone and re-admitted. */
  confirmRunning(id: string, runningFrame: Record<string, unknown>): void {
    this.wakes.delete(id)
    if (this.expired.delete(id)) {
      this.host.revive(id, runningFrame)
    }
  }

  /** A real ending replaces the guess, and nothing of that run may be revived afterwards. */
  drop(id: string): void {
    this.wakes.delete(id)
    this.expired.delete(id)
  }

  /** Settle the wakes that ran out before anyone reads the row; no further frame need arrive. */
  settleExpired(): void {
    // Runs on every drained frame: only the due front of the queue is touched.
    const now = this.wakes.size > 0 ? this.now() : 0
    for (const [ownerId, wake] of this.wakes) {
      if (wake.at > now) {
        return
      }
      this.wakes.delete(ownerId)
      this.host.restore(ownerId, wake.owner)
      // Only an owner actually put back may later be revived; a real ending already settled it.
      if (this.host.endedOwner(ownerId) === wake.owner) {
        this.expired.add(ownerId)
      }
    }
  }

  /** The next moment, on the monotonic clock, a wake stops guessing; the host restates the row then. */
  earliestExpiry(): number | undefined {
    for (const { at } of this.wakes.values()) {
      return at
    }
    return undefined
  }

  clear(): void {
    this.wakes.clear()
    this.expired.clear()
  }
}

export function claudeChildWake(host: ClaudeChildWakeHost): ClaudeChildWake {
  return new ClaudeChildWake(host)
}

export function childWorkEndedEvidence(
  id: string,
  run: string | undefined,
  outcome: EndedClaudeTask['outcome'],
  observedAt: number,
  reported?: { lastMessage?: string; totalTokens?: number }
): AgentChildWorkEvidence {
  return {
    type: 'ended',
    observedAt,
    handle: { idKind: 'task_id', id, ...(run !== undefined ? { runId: run } : {}) },
    outcome,
    ...(reported?.lastMessage ? { lastMessage: reported.lastMessage } : {}),
    ...(reported?.totalTokens !== undefined ? { totalTokens: reported.totalTokens } : {})
  }
}
