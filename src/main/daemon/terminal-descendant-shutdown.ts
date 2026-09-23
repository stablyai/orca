import * as descendantTermination from '../pty-descendant-termination'
import type { ProcessTableReader, DescendantSnapshot } from '../pty-descendant-termination'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty-descendant-exit-verification'

// Keep one fresh table for the short burst of verifier polls that follows a shutdown signal.
// This bounds process-table fanout without reusing a completed capture for a later polling round.
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

export function terminateShutdownDescendants(
  snapshot: DescendantSnapshot
): Promise<DescendantTreeVerdict> {
  if (snapshot.descendants.length === 0) {
    return Promise.resolve('exited')
  }
  return terminateDescendantSnapshotWithVerdict(snapshot, {
    // Leave room for capture and root exit within daemon-entry's 5s shutdown budget.
    verifyMs: 2500,
    timeoutMs: 250,
    keepAlive: true,
    requireIdentityBeforeSignal: true,
    readTable: readShutdownProcessTable
  })
}
