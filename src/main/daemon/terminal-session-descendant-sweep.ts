import * as descendantTermination from '../pty-descendant-termination'
import type { DescendantSnapshot, ProcessTableReader } from '../pty-descendant-termination'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import {
  hasLiveOwnedGroup,
  sweepSessionDescendants,
  type SessionDescendantSweepDeps
} from '../pty-session-descendant-sweep'
import { recordPtySessionGroups, type PtySessionProcessIdentity } from '../pty-session-identity'

// Keep one fresh table for the short burst of sweep rounds that follows a teardown signal.
// This bounds process-table fanout without reusing a completed capture for a later round.
let sharedShutdownCapture: {
  promise: ReturnType<ProcessTableReader>
  expires?: ReturnType<typeof setTimeout>
} | null = null

const readShutdownProcessTable: ProcessTableReader = (timeoutMs) => {
  if (sharedShutdownCapture) {
    return sharedShutdownCapture.promise
  }
  const promise = descendantTermination.readProcessTable(timeoutMs)
  sharedShutdownCapture = { promise }
  const clear = (): void => {
    if (sharedShutdownCapture?.promise === promise) {
      sharedShutdownCapture = null
    }
  }
  void promise.then(() => {
    const expires = setTimeout(clear, 25)
    expires.unref?.()
    if (sharedShutdownCapture?.promise === promise) {
      sharedShutdownCapture.expires = expires
    }
  }, clear)
  return promise
}

/**
 * The one sweep every terminal-session teardown runs — kill, daemon shutdown,
 * and natural PTY exit alike. Each drives it from the same session identity, so
 * what is reachable no longer depends on whether a live root survived to be
 * walked.
 */
export function sweepTerminalSessionDescendants(
  identity: PtySessionProcessIdentity,
  deps: SessionDescendantSweepDeps = {}
): Promise<DescendantTreeVerdict> {
  return sweepSessionDescendants(identity, {
    // Leave room for capture and root exit within daemon-entry's 5s shutdown budget.
    verifyMs: 2500,
    timeoutMs: 250,
    keepAlive: true,
    readTable: readShutdownProcessTable,
    ...deps
  })
}

/**
 * The kill-path entry: hands a pre-kill walk's groups to the session identity,
 * then sweeps from it. The walk is the last moment a live root can vouch for the
 * job groups its shell created.
 *
 * A walk that found nothing, with no other owned group still populated, settles
 * at once — the common kill leaves nothing behind, and it should cost no reads.
 */
export function sweepSessionFromSnapshot(
  identity: PtySessionProcessIdentity,
  snapshot: DescendantSnapshot,
  deps: SessionDescendantSweepDeps = {}
): Promise<DescendantTreeVerdict> {
  if (
    snapshot.descendants.length === 0 &&
    // The root's own group holds the root itself until the kill lands.
    !hasLiveOwnedGroup(identity, {
      exceptRootGroup: true,
      ...(deps.probeGroup ? { probeGroup: deps.probeGroup } : {})
    })
  ) {
    return Promise.resolve('exited')
  }
  recordPtySessionGroups(
    identity,
    snapshot.descendants.map((row) => row.pgid),
    snapshot.capturedAtMs
  )
  return sweepTerminalSessionDescendants(identity, deps)
}
