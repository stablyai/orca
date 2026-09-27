import * as descendantTermination from '../pty-descendant-termination'
import type { ProcessTableReader, DescendantSnapshot } from '../pty-descendant-termination'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty-descendant-exit-verification'
import {
  SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS,
  SHUTDOWN_DESCENDANT_VERIFY_MS
} from './immediate-kill-reply-budget'

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
    verifyMs: SHUTDOWN_DESCENDANT_VERIFY_MS,
    timeoutMs: SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS,
    keepAlive: true,
    requireIdentityBeforeSignal: true,
    readTable: readShutdownProcessTable
  })
}
