import { isSnapshotResult } from './rpc-subscription-result-shapes'

type SessionTabsStreamState = { method: string; sent?: boolean; receivedSnapshot?: boolean }

/** The host registers a tabs stream only as it emits the first snapshot, so an unsubscribe sent
 *  earlier finds nothing and the late stream lives until the socket closes. */
export function awaitsRegistration(stream: SessionTabsStreamState): boolean {
  return (
    stream.method === 'session.tabs.subscribe' && stream.sent === true && !stream.receivedSnapshot
  )
}

/** Returns true when `result` is the tabs stream's snapshot, i.e. the host has registered it. */
export function recordSnapshot(stream: SessionTabsStreamState, result: unknown): boolean {
  if (stream.method !== 'session.tabs.subscribe' || !isSnapshotResult(result)) {
    return false
  }
  stream.receivedSnapshot = true
  return true
}
