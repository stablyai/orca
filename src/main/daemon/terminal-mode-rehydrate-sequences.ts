import type { TerminalModes } from './types'

// Disarms every mouse-tracking protocol + SGR encoding a snapshot can re-arm
// (9/1000/1002/1003 + 1006/1016). Appended after content that seeds a
// brand-new session/emulator replacing a dead one (workspace Sleep, cold
// restore into a fresh runtime): that process never asked for mouse reports,
// so a plain shell left armed echoes raw SGR motion bytes on every pointer
// move (#12101). Must NOT be used on a live-session reattach, where the
// running agent legitimately owns mouse tracking.
export const DISARM_MOUSE_TRACKING_SEQUENCE =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'

// True when a restored snapshot had any mouse-tracking protocol or SGR mouse
// encoding armed — the only case where seeded content can carry an enable that
// a fresh session would otherwise keep (#12101). Legacy scrollback restores
// hardcode these off, so they pass through untouched.
export function restoreHasMouseTrackingArmed(modes: TerminalModes): boolean {
  return modes.mouseTracking || modes.sgrMouseMode === true || modes.sgrMousePixelsMode === true
}

// Why no kitty flags here: rehydrateSequences feeds renderer xterms, and
// POST_REPLAY_REATTACH_RESET's deliberate kitty reset (stale CSI-u Ctrl+C
// hazard) must stay authoritative. modes.kittyKeyboardFlags exists for
// emulator re-seed parity only; a re-seeded emulator answers ?0u and
// protocol-conformant programs re-push.
export function buildRehydrateSequences(modes: TerminalModes): string {
  const seqs: string[] = []
  if (modes.alternateScreen) {
    // Why: normal-buffer serialization can leave its pen active, while the
    // separately serialized alt body assumes it starts from default SGR.
    seqs.push('\x1b[0m\x1b[?1049h')
  }
  if (modes.bracketedPaste) {
    seqs.push('\x1b[?2004h')
  }
  if (modes.applicationCursor) {
    seqs.push('\x1b[?1h')
  }
  // Why: mobile alt-screen scroll gestures need xterm's mouse mode restored
  // from cold snapshots; OpenCode/OpenTUI enables scrollable panes this way.
  switch (modes.mouseTracking ? (modes.mouseTrackingMode ?? 'vt200') : 'none') {
    case 'x10':
      seqs.push('\x1b[?9h')
      break
    case 'vt200':
      seqs.push('\x1b[?1000h')
      break
    case 'drag':
      seqs.push('\x1b[?1002h')
      break
    case 'any':
      seqs.push('\x1b[?1003h')
      break
    case 'none':
      break
  }
  // Why: xterm tracks the mouse protocol and SGR encoding as independent
  // modes, so snapshots must preserve the encoding even when reporting is off.
  if (modes.sgrMousePixelsMode) {
    seqs.push('\x1b[?1016h')
  } else if (modes.sgrMouseMode) {
    seqs.push('\x1b[?1006h')
  }
  return seqs.join('')
}
