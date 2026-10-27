import type { BridgeHostDiagnostic } from './bridge-host'

// Deduplicate by kind except refused notify names/reasons and backlog stream ids; otherwise distinct faults and terminals hide each other.
function diagnosticKey(diagnostic: BridgeHostDiagnostic): string {
  if (diagnostic.kind === 'notify-refused' || diagnostic.kind === 'navigate-back-refused') {
    return `${diagnostic.kind}:${diagnostic.why}`
  }
  return diagnostic.kind === 'terminal-backlog'
    ? `${diagnostic.kind}:${diagnostic.id}`
    : diagnostic.kind
}

// Bound repeats for one host so frame failures cannot bury their first cause; a replacement host starts fresh.
export function createBridgeDiagnosticReporter(
  onReported?: (diagnostic: BridgeHostDiagnostic) => void
): (diagnostic: BridgeHostDiagnostic) => void {
  const reported = new Set<string>()
  return (diagnostic) => {
    const key = diagnosticKey(diagnostic)
    if (reported.has(key)) {
      return
    }
    reported.add(key)
    onReported?.(diagnostic)
    if (diagnostic.kind === 'refused') {
      console.warn('[web-shell-bridge] refused a page frame', diagnostic.refusal)
      return
    }
    if (diagnostic.kind === 'notify-refused') {
      // Keep name and session/grant refusal reason; neither determines the other.
      console.warn('[web-shell-bridge] refused a page notification', {
        name: diagnostic.name,
        why: diagnostic.why
      })
      return
    }
    if (diagnostic.kind === 'route-refused') {
      console.warn('[web-shell-bridge] refused to open the screen this shell named', {
        issue: diagnostic.issue
      })
      return
    }
    if (diagnostic.kind === 'storage-refused') {
      console.warn('[web-shell-bridge] refused a page write to a key it was not handed', {
        key: diagnostic.key
      })
      return
    }
    if (diagnostic.kind === 'navigate-back-refused') {
      // Distinguish an empty native stack from duplicate Back frames arriving before a queued pop commits.
      console.warn('[web-shell-bridge] did not pop the stack for a page going back', {
        why: diagnostic.why
      })
      return
    }
    if (diagnostic.kind === 'post-failed') {
      console.warn('[web-shell-bridge] the page could not be posted to', diagnostic.error)
      return
    }
    if (diagnostic.kind === 'notify-failed') {
      console.warn('[web-shell-bridge] the client threw on a page notification', diagnostic.error)
      return
    }
    if (diagnostic.kind === 'binary-lane-refused') {
      console.warn('[web-shell-bridge] a page asked for screencast frames it was not granted', {
        id: diagnostic.id
      })
      return
    }
    if (diagnostic.kind === 'binary-frame-dropped') {
      // One diagnostic per host cannot show ongoing frame loss; the dev-facts counter carries the running total.
      console.warn('[web-shell-bridge] a screencast frame did not fit and was dropped', {
        id: diagnostic.id,
        bytes: diagnostic.bytes,
        dropped: diagnostic.dropped
      })
      return
    }
    if (diagnostic.kind === 'terminal-backlog') {
      // Log coalesced/delivered ratio, peak cost and ended: both termination causes reach the page only as overflow.
      console.warn('[web-shell-bridge] a held terminal stream was retired', {
        id: diagnostic.id,
        coalescedFrames: diagnostic.coalescedFrames,
        deliveredFrames: diagnostic.deliveredFrames,
        peakPendingBytes: diagnostic.peakPendingBytes,
        ended: diagnostic.ended
      })
      return
    }
    console.warn('[web-shell-bridge] a view outlived its host and is still posting')
  }
}
