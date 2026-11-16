import { isSnapshotResult } from './rpc-subscription-result-shapes'

type SessionTabsStreamState = {
  method: string
  sent?: boolean
  receivedSnapshot?: boolean
  cancelled?: boolean
}

// Older hosts register only with the first snapshot, so hold cancellation until then; newer hosts safely tolerate the delay.
function awaitsRegistration(stream: SessionTabsStreamState): boolean {
  return (
    stream.method === 'session.tabs.subscribe' && stream.sent === true && !stream.receivedSnapshot
  )
}

/** Cancels a stream still awaiting its first snapshot; that snapshot then triggers the unsubscribe. */
export function holdUnsubscribe(stream: SessionTabsStreamState): boolean {
  if (!awaitsRegistration(stream)) {
    return false
  }
  stream.cancelled = true
  return true
}

/** Returns true when `result` is the tabs stream's snapshot, i.e. the host has registered it. */
export function recordSnapshot(stream: SessionTabsStreamState, result: unknown): boolean {
  if (stream.method !== 'session.tabs.subscribe' || !isSnapshotResult(result)) {
    return false
  }
  stream.receivedSnapshot = true
  return true
}
