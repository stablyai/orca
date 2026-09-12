import { MAX_CONCURRENT_STREAMS } from './protocol'
import { TooManyStreamsError, type RelayStreamRegistry } from './fs-stream-registry'

// Bound undelivered control frames per client, independently of released file descriptors.
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
    if (remaining <= 0) {
      byClient.delete(clientId)
      return
    }
    byClient.set(clientId, remaining)
  }
}
