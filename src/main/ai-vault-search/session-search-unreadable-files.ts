import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

/**
 * Consecutive failures at one stat before a file is left alone.
 *
 * Three rather than one, because a single failure is often a transcript being
 * rewritten under the read; three at the *same* mtime and size is not.
 */
export const SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT = 3

/**
 * A ceiling on how many held-out files are remembered. Dropping one means the
 * file is tried again, which is the safe direction: the queue re-fills, the
 * count re-climbs, and nothing is deleted or claimed.
 */
export const SESSION_SEARCH_HELD_OUT_LIMIT = 1_000

/**
 * Files the index has stopped trying to read.
 *
 * Why this exists: a transcript the reader cannot open, or one whose write
 * fails every time, is recorded stale by the consumer on every attempt. Without
 * a stop it sits in the queue being re-read for ever — the pass never settles,
 * the phase never reaches `current`, and one file with the wrong mode bits is
 * indistinguishable from a real backlog.
 *
 * The hold is released by the only thing that can mean the file changed: its
 * stat. An edit, a restore, or a `touch` after a `chmod` all move it; nothing
 * else does, which is why the hold cannot be a timer.
 */
export class SessionSearchUnreadableFiles {
  private readonly held = new Map<string, { stat: string; failures: number }>()

  constructor(
    private readonly limit = SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT,
    private readonly capacity = SESSION_SEARCH_HELD_OUT_LIMIT
  ) {}

  /** True when this file has failed enough times at this exact stat to stop trying. */
  holdsOut(candidate: SessionFileCandidate): boolean {
    const entry = this.held.get(candidate.file.path)
    if (!entry) {
      return false
    }
    if (entry.stat !== statKey(candidate)) {
      this.held.delete(candidate.file.path)
      return false
    }
    return entry.failures >= this.limit
  }

  /** Records a read that failed. A different stat starts the count over. */
  record(candidate: SessionFileCandidate): void {
    const stat = statKey(candidate)
    const path = candidate.file.path
    const entry = this.held.get(path)
    this.held.delete(path)
    this.held.set(path, { stat, failures: entry?.stat === stat ? entry.failures + 1 : 1 })
    while (this.held.size > this.capacity) {
      const oldest = this.held.keys().next()
      if (oldest.done) {
        break
      }
      this.held.delete(oldest.value)
    }
  }

  /** A read that landed: whatever this file's history, it is readable now. */
  clear(path: string): void {
    this.held.delete(path)
  }

  /** Files held out right now. A gauge, not a tally: it falls when one becomes readable. */
  get size(): number {
    let count = 0
    for (const entry of this.held.values()) {
      if (entry.failures >= this.limit) {
        count += 1
      }
    }
    return count
  }
}

function statKey(candidate: SessionFileCandidate): string {
  return `${candidate.file.mtimeMs}:${candidate.file.sizeBytes ?? -1}`
}
