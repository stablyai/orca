import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import {
  accountDaemonStreamEntry,
  releaseDaemonStreamEntry
} from './daemon-stream-entry-accounting'

export function removeQueuedObservations(
  batch: PendingStreamDataBatch | undefined,
  sessionId?: string
): void {
  if (!batch) {
    return
  }
  batch.queue = batch.queue.filter((entry) => {
    if (!entry.observation || (sessionId !== undefined && entry.sessionId !== sessionId)) {
      return true
    }
    releaseDaemonStreamEntry(batch, entry)
    entry.observation.release()
    return false
  })
  for (let i = 1; i < batch.queue.length; i++) {
    const previous = batch.queue[i - 1]
    const entry = batch.queue[i]
    if (
      entry.sessionId !== previous.sessionId ||
      (sessionId !== undefined && entry.sessionId !== sessionId) ||
      previous.control ||
      entry.control ||
      previous.observation ||
      entry.observation ||
      previous.queryOnly ||
      entry.queryOnly ||
      (previous.lease && entry.lease && previous.lease.counter !== entry.lease.counter) ||
      previous.transformed ||
      entry.transformed ||
      (previous.sequenceChars === 0) !== (entry.sequenceChars === 0)
    ) {
      continue
    }
    const rawLength =
      (previous.sequenceChars ?? previous.data.length) + (entry.sequenceChars ?? entry.data.length)
    releaseDaemonStreamEntry(batch, previous)
    previous.data += entry.data
    previous.sequenceChars = rawLength === previous.data.length ? undefined : rawLength
    previous.seq = entry.seq
    releaseDaemonStreamEntry(batch, entry)
    if (previous.lease && entry.lease) {
      previous.lease.absorb(entry.lease, 1024)
    } else if (!previous.lease) {
      previous.lease = entry.lease
      entry.lease = undefined
    }
    accountDaemonStreamEntry(batch, previous)
    batch.queue.splice(i--, 1)
  }
}
