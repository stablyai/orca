import type { TerminalModes } from './types'
import { RESET_GRAPHIC_RENDITION } from '../../shared/terminal-mode-reset-profiles'

// Why no kitty flags here: renderers re-assert the snapshot's kitty flags
// (carried beside the payload) in their replay epilogue, after these screen
// switches. A re-seeded emulator uses modes.kittyKeyboardFlags directly.
export function buildRehydrateSequences(modes: TerminalModes): string {
  const seqs: string[] = []
  if (modes.alternateScreen) {
    // Why: normal-buffer serialization can leave its pen active, while the
    // separately serialized alt body assumes it starts from default SGR.
    seqs.push(`${RESET_GRAPHIC_RENDITION}\x1b[?1049h`)
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
