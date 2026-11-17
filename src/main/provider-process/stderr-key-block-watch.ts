const KEY_BLOCK_MARKER = /-----(BEGIN|END) [A-Z ]+-----/g
// Longer than any marker, so one split across chunks is still seen whole.
const MARKER_CARRY_CHARS = 64

/** Follows a stream's private key blocks, which a bounded tail can cut from their BEGIN marker. */
export function createStderrKeyBlockWatch(): { observe(chunk: string): void; open(): boolean } {
  let open = false
  let carry = ''
  return {
    observe(chunk) {
      const text = carry + chunk
      for (const marker of text.matchAll(KEY_BLOCK_MARKER)) {
        open = marker[1] === 'BEGIN'
      }
      carry = text.slice(-MARKER_CARRY_CHARS)
    },
    open: () => open
  }
}
