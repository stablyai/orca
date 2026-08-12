import type { TerminalModes } from './types'

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
