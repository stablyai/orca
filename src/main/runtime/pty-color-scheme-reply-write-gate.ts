/**
 * Last-moment gate for CSI 997 color-scheme reports at the PTY write boundary.
 *
 * Every mode-2031 responder decides from the chunk it observed, then its reply
 * crosses a scheduling boundary (renderer IPC, remote protocol, fact relay)
 * before reaching the PTY. fish toggles ?2031h/?2031l around every prompt
 * repaint — several times within ~5ms at command accept — so a reply that was
 * correct for its chunk routinely lands after a later chunk withdrew the
 * subscription and the shell handed stdin to a child (#9993). Main ingests PTY
 * output ahead of every reply route, so it always holds fresher subscription
 * state than the responder that produced the reply: gate here, where the bytes
 * enter the PTY, instead of adding more timing rules at N decision sites.
 *
 * The gate keeps its own raw-byte scan so its state never depends on fact
 * consumers or per-pane reply ownership. While a PTY's scan authority is
 * delegated to the daemon the delivered bytes may be gapped, so the raw scan
 * stands down and the daemon's relayed 2031 facts feed the state instead.
 *
 * A ?996n DSR answer uses the same CSI 997 bytes but must never be dropped —
 * a one-shot query deserves its answer regardless of subscription state — so
 * main also counts observed ?996n queries and lets one report through per
 * pending query.
 */
import {
  INITIAL_MODE_2031_REPLY_SCAN_STATE,
  mode2031SequenceFor,
  scanMode2031ReplyDecision,
  type Mode2031ReplyScanState
} from '../../shared/terminal-color-scheme-protocol'

const MODE_2031_REPORTS: ReadonlySet<string> = new Set([
  mode2031SequenceFor('dark'),
  mode2031SequenceFor('light')
])

// Bound pending query slots: DSR answers are immediate, so real depth is 1.
const MAX_PENDING_COLOR_SCHEME_QUERY_REPLIES = 4

type PtyColorSchemeReplyGateState = {
  mode2031FinalState: 'subscribed' | 'unsubscribed' | null
  scanState: Mode2031ReplyScanState
  scanDelegated: boolean
  pendingColorSchemeQueryReplies: number
}

const gateStatesByPtyId = new Map<string, PtyColorSchemeReplyGateState>()

function getOrCreateState(ptyId: string): PtyColorSchemeReplyGateState {
  let state = gateStatesByPtyId.get(ptyId)
  if (!state) {
    state = {
      mode2031FinalState: null,
      scanState: INITIAL_MODE_2031_REPLY_SCAN_STATE,
      scanDelegated: false,
      pendingColorSchemeQueryReplies: 0
    }
    gateStatesByPtyId.set(ptyId, state)
  }
  return state
}

/** Feed one authoritative mode-2031 decision (daemon fact relay / main tracker). */
export function observePtyMode2031Decision(
  ptyId: string,
  decision: 'subscribed' | 'unsubscribed'
): void {
  getOrCreateState(ptyId).mode2031FinalState = decision
}

/**
 * While delegated, delivered bytes may be gapped (daemon keep-tail thinning) —
 * the raw scan would mint phantom decisions, so it stands down in favor of the
 * daemon's relayed facts. Boundaries reset the scan carry either way: a partial
 * escape from before the toggle must not corrupt what follows.
 */
export function setPtyColorSchemeScanDelegated(ptyId: string, delegated: boolean): void {
  const state = getOrCreateState(ptyId)
  state.scanDelegated = delegated
  state.scanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
}

/** A gap in delivered output invalidates the raw-scan carry. */
export function notePtyColorSchemeScanGap(ptyId: string): void {
  const state = gateStatesByPtyId.get(ptyId)
  if (state) {
    state.scanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
  }
}

/**
 * Feed one raw PTY output chunk at ingestion: tracks the chunk-final mode-2031
 * subscription state and counts ?996n color-scheme queries so their answers
 * pass the gate.
 */
export function observePtyOutputForColorSchemeProtocol(ptyId: string, data: string): void {
  const tracked = gateStatesByPtyId.get(ptyId)
  // Hot path: ordinary output touches no state and allocates nothing.
  if (!tracked && !data.includes('\x1b') && !data.includes('\x9b')) {
    return
  }
  const state = tracked ?? getOrCreateState(ptyId)
  if (!state.scanDelegated) {
    const result = scanMode2031ReplyDecision(state.scanState, data)
    state.scanState = result.state
    if (result.decision !== null) {
      state.mode2031FinalState = result.decision
    }
  }
  if (data.includes('\x1b[?996n') || data.includes('\x9b?996n')) {
    let count = 0
    for (let index = data.indexOf('996n'); index !== -1; index = data.indexOf('996n', index + 4)) {
      const prefix = data.slice(Math.max(0, index - 3), index)
      if (prefix.endsWith('\x1b[?') || prefix.endsWith('\x9b?')) {
        count += 1
      }
    }
    state.pendingColorSchemeQueryReplies = Math.min(
      state.pendingColorSchemeQueryReplies + count,
      MAX_PENDING_COLOR_SCHEME_QUERY_REPLIES
    )
  }
}

/**
 * Whether an input write must be dropped as a stale color-scheme report.
 * Only exact standalone CSI 997 reports are considered — responders send them
 * as whole writes, and user input (typed or bracketed paste) never matches.
 */
export function shouldDropStalePtyColorSchemeReply(ptyId: string, data: string): boolean {
  if (!MODE_2031_REPORTS.has(data)) {
    return false
  }
  const state = gateStatesByPtyId.get(ptyId)
  if (!state) {
    return false
  }
  if (state.pendingColorSchemeQueryReplies > 0) {
    state.pendingColorSchemeQueryReplies -= 1
    return false
  }
  return state.mode2031FinalState === 'unsubscribed'
}

/** Wired into PTY teardown so a replacement stream starts ungated. */
export function clearPtyColorSchemeReplyGate(ptyId: string): void {
  gateStatesByPtyId.delete(ptyId)
}

/** Test seam: reset module state between tests. */
export function _resetPtyColorSchemeReplyGateForTest(): void {
  gateStatesByPtyId.clear()
}
