import type { TerminalModes } from './types'
import { RESET_GRAPHIC_RENDITION } from '../../shared/terminal-mode-reset-profiles'

// Why: older checkpoints baked these into the stored rehydrateSequences string.
// Strip on restore so a dead TUI's DECSET cannot reach a replacement shell.
const MOUSE_REHYDRATE_ENABLE_SEQUENCES = [
  '\x1b[?9h',
  '\x1b[?1000h',
  '\x1b[?1002h',
  '\x1b[?1003h',
  '\x1b[?1006h',
  '\x1b[?1016h'
] as const

export function omitMouseTrackingFromRehydrateSequences(sequences: string): string {
  let result = sequences
  for (const sequence of MOUSE_REHYDRATE_ENABLE_SEQUENCES) {
    result = result.replaceAll(sequence, '')
  }
  return result
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
    seqs.push(`${RESET_GRAPHIC_RENDITION}\x1b[?1049h`)
  }
  if (modes.bracketedPaste) {
    seqs.push('\x1b[?2004h')
  }
  if (modes.applicationCursor) {
    seqs.push('\x1b[?1h')
  }
  // Why omitted: restoring DECSET 1003/1006 without the TUI that owned them
  // types SGR motion reports into readline (#18424). Live TUIs re-assert on
  // startup; alt-screen frame restore still carries mouse for a live owner.
  return seqs.join('')
}
