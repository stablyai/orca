import type { TerminalDocumentScope } from './document-scope'

/**
 * What the latency harness needs to know about the screen, reported to the host only when the
 * page started with probes on (see `terminal-latency-probes.ts`).
 *
 * The signature is cheap on purpose: the first and last `L<digits>` line marker on screen (the
 * harness's workloads number their lines) and the text after the last `zq` (the harness types
 * lines that start with it), so scroll position and echoed input are readable without sending
 * the screen.
 */
const LINE_MARKER = /L\d{3,6}/
const TYPED_LINE_PREFIX = 'zq'
const TYPED_LINE_LIMIT = 48

export function reportLatencyScreen(scope: TerminalDocumentScope) {
  if (!scope.start().latencyProbes || !scope.term) {
    return
  }
  const term = scope.term
  const buffer = term.buffer.active
  let top = ''
  let bot = ''
  let zq = ''
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    if (!line) {
      continue
    }
    const text = line.translateToString(true)
    const marker = LINE_MARKER.exec(text)
    if (marker) {
      top = top || marker[0]
      bot = marker[0]
    }
    const at = text.lastIndexOf(TYPED_LINE_PREFIX)
    if (at !== -1) {
      zq = text.slice(at, at + TYPED_LINE_LIMIT).replace(/\s+$/, '')
    }
  }
  const signature = top + '|' + bot + '|' + zq
  if (signature === scope.latencyScreenSignature) {
    return
  }
  scope.latencyScreenSignature = signature
  scope.postToHost({ type: 'latency-screen', t: Date.now(), top, bot, zq, alt: buffer.type })
}

export function reportLatencyTouch(scope: TerminalDocumentScope, phase: 'touchstart' | 'touchend') {
  if (scope.start().latencyProbes) {
    scope.postToHost({ type: 'latency-touch', t: Date.now(), phase })
  }
}
