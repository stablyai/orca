import { KEY_BLOCK_MARKER } from '../observability/redactor'

// Longer than any marker, so one split across chunks is still seen whole.
const MARKER_CARRY_CHARS = 64
// More markers than an 8 KiB tail can hold.
const KEPT_MARKERS = 1024

/** Follows a stream's private key blocks, which a bounded tail can cut from their BEGIN marker. */
export function createStderrKeyBlockWatch(): {
  observe(chunk: string): void
  /** Whether the stream was inside a key block before its last `laterMarkers` markers. */
  inBlockBefore(laterMarkers: number): boolean
} {
  const begins: boolean[] = []
  let carry = ''
  let carryStart = 0
  let countedThrough = 0
  return {
    observe(chunk) {
      const text = carry + chunk
      for (const marker of text.matchAll(KEY_BLOCK_MARKER)) {
        const end = carryStart + marker.index + marker[0].length
        // The carry repeats text already scanned; count each marker once.
        if (end > countedThrough) {
          countedThrough = end
          begins.push(marker[1] === 'BEGIN')
          if (begins.length > KEPT_MARKERS) {
            begins.shift()
          }
        }
      }
      carry = text.slice(-MARKER_CARRY_CHARS)
      carryStart += text.length - carry.length
    },
    inBlockBefore: (laterMarkers) => begins[begins.length - 1 - laterMarkers] ?? false
  }
}
