import type { BridgeHostDiagnostic } from './bridge-host'

/**
 * What a repeat is, for the line bound below.
 *
 * The kind on its own for everything the host reports once per cause. Not for a refused `notify`:
 * a page that was told nothing and a page reaching past what it was told are different faults, and
 * the first would otherwise bury the second for the life of the host. Not for a backlog either: a
 * shell holds one stream per open terminal, and under the kind alone only the first ever reported.
 */
function diagnosticKey(diagnostic: BridgeHostDiagnostic): string {
  if (diagnostic.kind === 'notify-refused' || diagnostic.kind === 'navigate-back-refused') {
    return `${diagnostic.kind}:${diagnostic.why}`
  }
  return diagnostic.kind === 'terminal-backlog'
    ? `${diagnostic.kind}:${diagnostic.id}`
    : diagnostic.kind
}

/**
 * One line per kind, for the life of one host.
 *
 * A page that is failing frames fails all of them, and a line each buries the first — the one that
 * says why. The host already holds `post-failed` to one; this is the same bound for the kinds it
 * does not, and a new host starts the count over because a new page is new evidence.
 */
export function createBridgeDiagnosticReporter(): (diagnostic: BridgeHostDiagnostic) => void {
  const reported = new Set<string>()
  return (diagnostic) => {
    const key = diagnosticKey(diagnostic)
    if (reported.has(key)) {
      return
    }
    reported.add(key)
    if (diagnostic.kind === 'refused') {
      console.warn('[web-shell-bridge] refused a page frame', diagnostic.refusal)
      return
    }
    if (diagnostic.kind === 'notify-refused') {
      // Both halves, because neither is derivable from the other: which name the page posted, and
      // whether the host had issued it anything at all.
      console.warn('[web-shell-bridge] refused a page notification', {
        name: diagnostic.name,
        why: diagnostic.why
      })
      return
    }
    if (diagnostic.kind === 'route-refused') {
      // The shell's own bug, not the page's: this host serves no session at all until it is fixed.
      console.warn('[web-shell-bridge] refused to open the screen this shell named', {
        issue: diagnostic.issue
      })
      return
    }
    if (diagnostic.kind === 'storage-refused') {
      // Named, because the key is the whole evidence: it says which host's list the page reached for.
      console.warn('[web-shell-bridge] refused a page write to a key it was not handed', {
        key: diagnostic.key
      })
      return
    }
    if (diagnostic.kind === 'navigate-back-refused') {
      // Named, because the two are different bugs: an empty stack is a page opened as the first
      // screen, and a pending pop is a page posting the frame twice in one batch.
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
      // Once per host, like every other kind, which is why the running total is on the dev facts:
      // a stream shedding a frame a second prints this line exactly as often as one that shed one.
      console.warn('[web-shell-bridge] a screencast frame did not fit and was dropped', {
        id: diagnostic.id,
        bytes: diagnostic.bytes,
        dropped: diagnostic.dropped
      })
      return
    }
    if (diagnostic.kind === 'terminal-backlog') {
      // All five, because the rule is only readable in their ratio: frames coalesced against frames
      // delivered is what the holding bought, the peak is what it cost, and `ended` is the only
      // place the two ways a held stream dies are told apart — both reach the page as `overflow`.
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
