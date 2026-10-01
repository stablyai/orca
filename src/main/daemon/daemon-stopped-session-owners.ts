import type { IPtyProvider } from '../providers/types'
import { withinDeadline } from './daemon-generation-listing'

const MAX_STOPPED_SESSION_OWNERS = 512

/**
 * Which provider each id was last asked to stop by, so the stop is confirmed by that owner alone.
 * Another version's silence says nothing about a session it never held. In memory only: a new stop
 * of the id replaces its entry, and the oldest entries fall off past the cap.
 */
export class DaemonStoppedSessionOwners<T extends IPtyProvider> {
  private readonly owners = new Map<string, T>()

  /** Spawn passes no owner to clear the entry, so a stale owner never answers for a new session. */
  record(sessionId: string | undefined, owner: T | undefined): void {
    if (sessionId === undefined) {
      return
    }
    this.owners.delete(sessionId)
    if (!owner) {
      return
    }
    this.owners.set(sessionId, owner)
    if (this.owners.size > MAX_STOPPED_SESSION_OWNERS) {
      const oldest = this.owners.keys().next().value
      if (oldest !== undefined) {
        this.owners.delete(oldest)
      }
    }
  }

  forgetOwner(owner: T): void {
    for (const [sessionId, recorded] of this.owners) {
      if (recorded === owner) {
        this.owners.delete(sessionId)
      }
    }
  }

  /** true = gone from its owner, false = its owner still holds it, null = nobody could say. */
  async confirm(
    sessionId: string,
    probeWithoutOwner: () => Promise<boolean | null>,
    deadlineMs?: number
  ): Promise<boolean | null> {
    const owner = this.owners.get(sessionId)
    const probe = owner
      ? owner.probePtyLiveness
        ? owner.probePtyLiveness(sessionId, deadlineMs === undefined ? undefined : { deadlineMs })
        : Promise.resolve(owner.hasPty?.(sessionId) ?? null)
      : probeWithoutOwner()
    try {
      const live = await withinDeadline(probe, deadlineMs)
      return live === null ? null : !live
    } catch {
      return null
    }
  }
}
