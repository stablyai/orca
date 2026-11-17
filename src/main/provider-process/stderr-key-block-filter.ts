// Real labels run to about 30 characters; the bound keeps every marker inside the carry.
const BEGIN = /-----BEGIN [A-Z ]{1,40}-----/
const END = /-----END [A-Z ]{1,40}-----/
// Longer than any marker, so one split across chunks is still found whole.
const MARKER_CARRY_CHARS = 64

/** Length of the longest suffix that may still grow into a marker; held back until it can't. */
function partialMarkerLength(text: string, word: 'BEGIN' | 'END'): number {
  const head = `-----${word} `
  for (let start = Math.max(0, text.length - MARKER_CARRY_CHARS); start < text.length; start++) {
    const rest = text.slice(start)
    if (
      head.startsWith(rest) ||
      (rest.startsWith(head) && /^[A-Z ]{0,40}-{0,4}$/.test(rest.slice(head.length)))
    ) {
      return rest.length
    }
  }
  return 0
}

/** Replaces each private key block in a stream with `[redacted:pem]` before anything stores it;
 *  a block that never ends is dropped through the end of the stream. */
export function createStderrKeyBlockFilter(): { push(chunk: string): string; end(): string } {
  let pending = ''
  let inBlock = false
  const take = (final: boolean): string => {
    let out = ''
    for (;;) {
      const marker = (inBlock ? END : BEGIN).exec(pending)
      if (!marker) {
        const held = final ? 0 : partialMarkerLength(pending, inBlock ? 'END' : 'BEGIN')
        if (!inBlock) {
          out += pending.slice(0, pending.length - held)
        }
        pending = pending.slice(pending.length - held)
        return out
      }
      if (!inBlock) {
        out += `${pending.slice(0, marker.index)}[redacted:pem]`
      }
      pending = pending.slice(marker.index + marker[0].length)
      inBlock = !inBlock
    }
  }
  return {
    push: (chunk) => {
      pending += chunk
      return take(false)
    },
    end: () => take(true)
  }
}
