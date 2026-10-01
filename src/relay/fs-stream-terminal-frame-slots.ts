import { MAX_CONCURRENT_STREAMS } from './protocol'
import { TooManyStreamsError, type RelayStreamRegistry } from './fs-stream-registry'

/**
 * Terminal frames (fs.streamEnd/fs.streamError) ride the control lane, which does not
 * drop on overflow — it destroys the link at 256 queued frames / 1 MB. A stream's
 * registry slot is gone the moment its last chunk is read, so on a socket that is not
 * draining, back-to-back reads could stack one undelivered terminal frame each until
 * that budget blew. Holding the slot until the frame settles keeps the number of queued
 * terminal frames at MAX_CONCURRENT_STREAMS, far below the killing threshold; the
 * overflow now costs one refused read (TooManyStreams, which clients already handle)
 * instead of the whole connection.
 *
 * Counted per client, because the control queue this protects is per client: one peer whose
 * socket stopped draining must not refuse reads for every other peer on the same relay.
 * Counted independently of released file descriptors, and each slot is a registry operation
 * so shutdown waits for undelivered terminal frames too.
 */
const pendingTerminalFramesByClient = new WeakMap<RelayStreamRegistry, Map<number, number>>()

export function reserveTerminalFrameSlot(
  registry: RelayStreamRegistry,
  clientId: number
): () => void {
  let byClient = pendingTerminalFramesByClient.get(registry)
  if (!byClient) {
    byClient = new Map()
    pendingTerminalFramesByClient.set(registry, byClient)
  }
  const pending = byClient.get(clientId) ?? 0
  if (pending >= MAX_CONCURRENT_STREAMS) {
    throw new TooManyStreamsError()
  }
  const finish = registry.beginOperation()
  byClient.set(clientId, pending + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    finish()
    const remaining = (byClient.get(clientId) ?? 1) - 1
    // Drop the entry at zero so a long-lived registry cannot accumulate one per detached client.
    if (remaining <= 0) {
      byClient.delete(clientId)
      return
    }
    byClient.set(clientId, remaining)
  }
}
