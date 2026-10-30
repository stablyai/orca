import type { TerminalModes } from './types'
import { RESET_GRAPHIC_RENDITION } from '../../shared/terminal-mode-reset-profiles'

// Restore kitty flags separately after screen switches, which swap their state.
export function buildRehydrateSequences(modes: TerminalModes): string {
  const seqs: string[] = []
  if (modes.alternateScreen) {
    // The alternate buffer assumes default SGR; normal-buffer replay may leave a different pen active.
    seqs.push(`${RESET_GRAPHIC_RENDITION}\x1b[?1049h`)
  }
  if (modes.bracketedPaste) {
    seqs.push('\x1b[?2004h')
  }
  if (modes.applicationCursor) {
    seqs.push('\x1b[?1h')
  }
  // Input mirrors consume XTMODKEYS to preserve modified Enter; xterm ignores it.
  if (modes.modifyOtherKeys !== undefined) {
    seqs.push(`\x1b[>4;${modes.modifyOtherKeys}m`)
  }
  const trackingMode = modes.mouseTracking ? (modes.mouseTrackingMode ?? 'vt200') : 'none'
  switch (trackingMode) {
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
  // Mouse encoding is independent of tracking and must survive even when reporting is off.
  if (modes.sgrMousePixelsMode) {
    seqs.push('\x1b[?1016h')
  } else if (modes.sgrMouseMode) {
    seqs.push('\x1b[?1006h')
  } else if (trackingMode !== 'none') {
    // Emit default encoding explicitly so replay readers need not infer it.
    seqs.push('\x1b[?1006l')
  }
  return seqs.join('')
}
