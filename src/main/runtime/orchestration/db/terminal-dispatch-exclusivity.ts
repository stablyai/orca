import type { OrchestrationDb } from './orchestration-db'

/** One terminal works for one Dispatch at a time, local or remote, so its later mail has one owner. */
export function assertNoActiveRemoteWorker(
  db: OrchestrationDb,
  handle: string,
  paneKey: string | null | undefined
): void {
  const remote = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
  if (remote) {
    throw new Error(`Terminal ${handle} already has active remote Dispatch ${remote.dispatch_id}.`)
  }
}
