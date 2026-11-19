import { MAX_HANG_WORKER_SENDS, type HangWorkerSend } from './hang-observation-schema'
import { readWorkerSendLedger } from '../worker-threads/worker-send-ledger'

/** Latest sends first: the message a stuck main thread is receiving was posted most recently. */
export function recentWorkerSends(now: number): HangWorkerSend[] {
  return readWorkerSendLedger()
    .filter((slot) => slot.sends > 0)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, MAX_HANG_WORKER_SENDS)
    .map((slot) => ({
      role: slot.role,
      kind: slot.lastKind,
      items: slot.lastItems,
      bytes: slot.lastBytes,
      depth: slot.lastDepth,
      agoMs: Math.max(0, now - slot.lastAt),
      heapUsedMB: slot.heapUsedMB
    }))
}
