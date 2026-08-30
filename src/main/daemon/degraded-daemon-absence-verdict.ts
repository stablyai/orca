import { BoundedMap } from '../../shared/bounded-map'
import type { IPtyProvider, PtySpawnResult } from '../providers/types'

/**
 * What a session id's absence proves in the degraded router.
 *
 * The router forgets a session's route the moment that session exits, and the absence
 * verdict is only ever read after that, so the owner that watched the exit is remembered
 * here rather than inferred from the routing table. Only an owner this router recorded —
 * currently routed, or seen to watch the exit — may answer; an id neither table knows was
 * never observed here, so its absence is a lost route, not a death certificate.
 */
export class DegradedDaemonAbsenceVerdict {
  private readonly watchedExitOwners = new BoundedMap<string, IPtyProvider>({ maxEntries: 1_024 })

  constructor(private readonly routes: ReadonlyMap<string, IPtyProvider>) {}

  /** The provider that emitted the exit is the one that watched it. */
  recordWatchedExit(sessionId: string, owner: IPtyProvider): void {
    this.watchedExitOwners.set(sessionId, owner)
  }

  /** A reopened pane reuses the session id, so spawning retires any certificate held for
   *  it — the dead incarnation's owner must not answer for its replacement, the same
   *  reason LocalPtyProvider drops its own tombstone on spawn.
   *
   *  Gated because retiring a certificate and recording a route are the same event: a spawn
   *  that reports the pty exited before its reply establishes no route (see the matching guard
   *  in DegradedDaemonFreshSpawnRouter.spawn), so the certificate it just earned is the only
   *  record of that exit. Retiring it there would replace a watched death with `unverifiable`.
   *  DaemonPtyRouter.spawn gates its own retirement on the same flag. */
  async observeSpawn(spawn: Promise<PtySpawnResult>): Promise<PtySpawnResult> {
    const spawned = await spawn
    if (!spawned.exitedBeforeSpawnReply) {
      this.watchedExitOwners.delete(spawned.id)
    }
    return spawned
  }

  read(sessionId: string): 'exited' | 'unverifiable' {
    return (
      (this.routes.get(sessionId) ?? this.watchedExitOwners.get(sessionId))?.ptyAbsenceVerdict?.(
        sessionId
      ) ?? 'unverifiable'
    )
  }
}
