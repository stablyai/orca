const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'

export function truncateUnclosedAlternateScreen(data: string): string {
  let depth = 0
  let outermostUnmatchedOnIdx = -1
  let searchFrom = 0
  while (searchFrom < data.length) {
    const onIdx = data.indexOf(ALT_SCREEN_ON, searchFrom)
    const offIdx = data.indexOf(ALT_SCREEN_OFF, searchFrom)
    if (onIdx === -1 && offIdx === -1) {
      break
    }
    if (onIdx !== -1 && (offIdx === -1 || onIdx < offIdx)) {
      if (depth === 0) {
        outermostUnmatchedOnIdx = onIdx
      }
      depth++
      searchFrom = onIdx + ALT_SCREEN_ON.length
    } else {
      if (depth > 0) {
        depth--
      }
      searchFrom = offIdx + ALT_SCREEN_OFF.length
    }
  }
  return depth > 0 && outermostUnmatchedOnIdx !== -1 ? data.slice(0, outermostUnmatchedOnIdx) : data
}
