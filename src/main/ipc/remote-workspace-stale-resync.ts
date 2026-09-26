import type { RemoteWorkspaceObservedSnapshot } from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import { readRemoteSnapshot } from './remote-workspace-relay-sync'
import {
  getCachedRemoteWorkspaceSnapshot,
  remoteWorkspaceSnapshotsAreIdentical,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import { remoteWorkspaceSessionMatchesSnapshot } from './remote-workspace-snapshot-normalization'

type PendingResync = { promise: Promise<void>; requeued: boolean }

const pendingByTargetId = new Map<string, PendingResync>()

export function _resetRemoteWorkspaceStaleResyncForTests(): void {
  pendingByTargetId.clear()
}

export function isRemoteWorkspaceResyncInFlight(targetId: string): boolean {
  return pendingByTargetId.has(targetId)
}

/**
 * The relay told us it could not deliver a snapshot, so pull it. `workspace.get` is a response, and
 * responses are admitted against the megabyte-scale control/legacy-response budget rather than the
 * single ~12KB producer frame that refused the broadcast — the payload was never too big for the
 * link, only for that one lane.
 */
export function resyncStaleRemoteWorkspace(
  target: SshTarget,
  deliver: (snapshot: RemoteWorkspaceObservedSnapshot) => void,
  onError: (error: unknown) => void = () => {}
): Promise<void> {
  const existing = pendingByTargetId.get(target.id)
  if (existing) {
    // Why: a burst of markers must collapse to one extra read, but never to zero — a marker that
    // arrived while a read was already in flight may describe a revision that read did not see.
    existing.requeued = true
    return existing.promise
  }
  const pending: PendingResync = { requeued: false, promise: Promise.resolve() }
  pending.promise = (async () => {
    try {
      do {
        pending.requeued = false
        const cachedBeforeRead = getCachedRemoteWorkspaceSnapshot(target.id)
        const observation = await readRemoteSnapshot(target, (snapshot) => {
          // An own patch reply can update the cache while this read is pending.
          const previous = getCachedRemoteWorkspaceSnapshot(target.id)
          if (previous?.hostObservationToken !== cachedBeforeRead?.hostObservationToken) {
            // Reread a conflicting observation; revision comparisons would reject valid relay resets.
            pending.requeued ||= !remoteWorkspaceSnapshotsAreIdentical(previous, snapshot)
            return null
          }
          return {
            unchanged: remoteWorkspaceSessionMatchesSnapshot(previous, snapshot.session),
            snapshot: rememberRemoteWorkspaceSnapshot(target.id, snapshot)
          }
        })
        if (!observation) {
          continue
        }
        // Suppress the echo: our own patch response already cached this session, and re-publishing it
        // makes the renderer rehydrate a state it authored.
        if (observation.unchanged) {
          continue
        }
        const latest = getCachedRemoteWorkspaceSnapshot(target.id)
        if (
          latest?.hostObservationToken !== observation.snapshot.hostObservationToken &&
          !remoteWorkspaceSnapshotsAreIdentical(latest, observation.snapshot)
        ) {
          pending.requeued = true
          continue
        }
        deliver(observation.snapshot)
      } while (pending.requeued)
    } catch (error) {
      onError(error)
    } finally {
      pendingByTargetId.delete(target.id)
    }
  })()
  pendingByTargetId.set(target.id, pending)
  return pending.promise
}
