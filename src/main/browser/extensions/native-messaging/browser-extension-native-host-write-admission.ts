import { HEADER_BYTES } from './browser-extension-native-host-framing'

const MAX_OUTGOING_MESSAGE_BYTES = 64 * 1024 * 1024
// Why two frames: a healthy host still owns a max-size frame while the next message is queued.
const MAX_HOST_WRITE_BYTES = 2 * (MAX_OUTGOING_MESSAGE_BYTES + HEADER_BYTES)
const MAX_PROCESS_WRITE_BYTES = 2 * MAX_HOST_WRITE_BYTES
const MAX_HOST_WRITES = 256
const MAX_PROCESS_WRITES = 1024

type Holder = { bytes: number; writes: number; evict: () => void }

const holders = new Set<Holder>()
let processWriteBytes = 0
let processWrites = 0

function largestOtherHolder(self: Holder, byBytes: boolean): Holder | undefined {
  let largest: Holder | undefined
  for (const holder of holders) {
    const size = byBytes ? holder.bytes : holder.writes
    if (
      holder !== self &&
      size > 0 &&
      (!largest || size > (byBytes ? largest.bytes : largest.writes))
    ) {
      largest = holder
    }
  }
  return largest
}

/**
 * Bounds one host's outstanding stdin writes. When the process-wide budget is full, the host
 * holding the most is evicted (it, not the claimant, is the stalled one) through `onEvict`.
 */
export function createNativeHostWriteAdmission(onEvict: () => void): {
  claim: (bodyBytes: number) => (() => void) | undefined
  close: () => void
} {
  const pending = new Set<() => void>()
  let closed = false

  const close = (): void => {
    closed = true
    holders.delete(self)
    for (const release of pending) {
      release()
    }
  }
  const self: Holder = {
    bytes: 0,
    writes: 0,
    evict: () => {
      close()
      onEvict()
    }
  }
  holders.add(self)

  const claim = (bodyBytes: number): (() => void) | undefined => {
    const bytes = HEADER_BYTES + bodyBytes
    if (
      closed ||
      bodyBytes > MAX_OUTGOING_MESSAGE_BYTES ||
      self.writes >= MAX_HOST_WRITES ||
      self.bytes + bytes > MAX_HOST_WRITE_BYTES
    ) {
      return undefined
    }
    while (
      processWrites >= MAX_PROCESS_WRITES ||
      processWriteBytes + bytes > MAX_PROCESS_WRITE_BYTES
    ) {
      const byBytes = processWriteBytes + bytes > MAX_PROCESS_WRITE_BYTES
      const victim = largestOtherHolder(self, byBytes)
      if (!victim || (byBytes ? victim.bytes <= self.bytes : victim.writes <= self.writes)) {
        return undefined
      }
      victim.evict()
      if (closed) {
        return undefined
      }
    }
    self.bytes += bytes
    self.writes++
    processWriteBytes += bytes
    processWrites++
    const release = (): void => {
      if (!pending.delete(release)) {
        return
      }
      self.bytes -= bytes
      self.writes--
      processWriteBytes -= bytes
      processWrites--
    }
    pending.add(release)
    return release
  }

  return { claim, close }
}
