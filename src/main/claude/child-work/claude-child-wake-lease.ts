// A wake holds its owner only while the provider may still be resuming it. Claude does not run an
// owner again when its surviving descendants end, so an unbounded wake left the row working for good.

import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { EndedClaudeTask } from './claude-child-work-evidence'

/** Long enough for a resumed owner's first frame, short enough that a wrong guess settles quickly. */
export const CLAUDE_CHILD_WAKE_LEASE_MS = 60_000

type Wake = {
  at: number
  owner: EndedClaudeTask
  /** Puts the owner back to the ending the wake guessed past. */
  settle: (owner: EndedClaudeTask) => void
}

/** Wakes by owner id, each with the moment it stops guessing. */
export class ClaudeChildWakeLease {
  private readonly wakes = new Map<string, Wake>()

  hold(ownerId: string, owner: EndedClaudeTask, settle: (owner: EndedClaudeTask) => void): void {
    this.wakes.set(ownerId, { at: Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS, owner, settle })
  }

  /** A frame about this id proves the provider runs it, so the guess is no longer needed. */
  release(id: string | null | undefined): void {
    if (id !== null && id !== undefined) {
      this.wakes.delete(id)
    }
  }

  /** Wakes whose lease ran out, asked to settle before anyone reads the row. */
  settleExpired(now: number): void {
    const due = [...this.wakes].filter(([, wake]) => wake.at <= now)
    for (const [ownerId, wake] of due) {
      this.wakes.delete(ownerId)
      wake.settle(wake.owner)
    }
  }

  /** The next moment a wake stops guessing; the host rests the row then. */
  earliestExpiry(): number | undefined {
    let earliest: number | undefined
    for (const wake of this.wakes.values()) {
      earliest = earliest === undefined ? wake.at : Math.min(earliest, wake.at)
    }
    return earliest
  }

  clear(): void {
    this.wakes.clear()
  }
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
