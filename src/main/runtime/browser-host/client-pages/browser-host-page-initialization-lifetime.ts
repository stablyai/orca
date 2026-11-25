import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type {
  InitializationAdmission,
  InitializationRecord,
  InitializationQueue
} from './browser-host-page-initialization-records'

export function retireInitializationAuthority(
  records: Map<string, InitializationRecord>,
  queues: Map<symbol, InitializationQueue>,
  attachments: Map<string, BrowserHostLeaseState>,
  releaseAdmission: (admission: InitializationAdmission) => void,
  enqueue: (record: InitializationRecord, admission: InitializationAdmission) => void,
  claimCleanup: (id: string) => () => void,
  removeRecord: (record: InitializationRecord) => void,
  state: BrowserHostLeaseState
): void {
  if (attachments.get(state.lease.browserHostClientId) === state) {
    attachments.delete(state.lease.browserHostClientId)
  }
  for (const record of records.values()) {
    if (record.successor?.state === state) {
      releaseAdmission(record.successor)
      record.successor = undefined
    }
    if (record.scope !== state) {
      continue
    }
    record.legacyAttempt?.cancel()
    record.legacyAttempt = undefined
    const operation = record.operation
    if (operation?.admission.state === state) {
      operation.removePreparation?.()
      operation.removePreparation = undefined
      operation.detached = true
      operation.cleanupRequested = undefined
      operation.cleanupAttempt = undefined
      operation.controller.abort()
      releaseAdmission(operation.admission)
      operation.releaseGrant?.()
      operation.releaseGrant = undefined
      operation.closing?.absent()
      record.operation = undefined
    }
    record.releaseCleanup?.()
    record.releaseCleanup = undefined
    record.target = undefined
    record.targetExecutionHostKey = undefined
    record.scope = undefined
    record.observer = undefined
    record.authorityRetired = true
    const successor = record.successor
    record.successor = undefined
    if (
      successor &&
      !record.closed &&
      !successor.input.signal?.aborted &&
      successor.connectionToken === successor.state.connectionToken &&
      successor.input.isCurrent()
    ) {
      record.browserHostClientId = successor.state.lease.browserHostClientId
      record.authorityRetired = false
      record.target = successor.input.previous
      record.observer = successor
      record.releaseCleanup = claimCleanup(record.browserPageId)
      enqueue(record, successor)
    } else {
      if (successor) {
        releaseAdmission(successor)
      }
      if (record.closed || record.stopped) {
        removeRecord(record)
      }
    }
  }
  queues.delete(state.token)
}
