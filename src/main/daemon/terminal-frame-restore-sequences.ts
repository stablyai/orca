import type { Terminal } from '@xterm/headless'
import type { SerializeAddon } from '@xterm/addon-serialize'
import {
  buildAbsoluteCursorRestoreSequence,
  readSavedCursorRegister
} from '../../shared/terminal-serialize-absolute-cursor'
import type { SavedCursorRegister } from '../../shared/terminal-serialize-absolute-cursor'
import type { TerminalModes } from './types'

export function buildFrameRestoreSnapshotFields(
  serializer: SerializeAddon,
  terminal: Terminal,
  modes: TerminalModes
): { frameRestoreAnsi?: string } {
  return modes.alternateScreen
    ? {
        frameRestoreAnsi: buildTerminalFrameRestoreSequences(
          serializer,
          terminal,
          modes,
          readSavedCursorRegister(terminal)
        )
      }
    : {}
}

/** Restores live terminal state without replaying an alternate-screen frame. */
function buildTerminalFrameRestoreSequences(
  serializer: SerializeAddon,
  terminal: Terminal,
  modes: TerminalModes,
  savedCursor: SavedCursorRegister | null
): string {
  const terminalModes = terminal.modes
  const seqs: string[] = ['\x1b[0m\x1b[?1049h', serializeCurrentSgrState(serializer, terminal)]
  if (terminalModes.applicationCursorKeysMode) {
    seqs.push('\x1b[?1h')
  }
  if (terminalModes.applicationKeypadMode) {
    seqs.push('\x1b[?66h')
  }
  if (terminalModes.bracketedPasteMode) {
    seqs.push('\x1b[?2004h')
  }
  if (terminalModes.insertMode) {
    seqs.push('\x1b[4h')
  }
  if (terminalModes.reverseWraparoundMode) {
    seqs.push('\x1b[?45h')
  }
  if (terminalModes.sendFocusMode) {
    seqs.push('\x1b[?1004h')
  }
  if (!terminalModes.wraparoundMode) {
    seqs.push('\x1b[?7l')
  }
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
  if (modes.sgrMousePixelsMode) {
    seqs.push('\x1b[?1016h')
  } else if (modes.sgrMouseMode) {
    seqs.push('\x1b[?1006h')
  }
  if (!terminalModes.showCursor) {
    seqs.push('\x1b[?25l')
  }
  seqs.push(
    buildAbsoluteCursorRestoreSequence(terminal, savedCursor, {
      restoreModesWithoutCursor: true
    })
  )
  return seqs.join('')
}

function serializeCurrentSgrState(serializer: SerializeAddon, terminal: Terminal): string {
  // Unsupported addon behavior under our vendored patch: an out-of-range row emits only its authoritative pen-state diff.
  const emptyRow = terminal.buffer.normal.length
  return serializer.serialize({
    range: { start: emptyRow, end: emptyRow },
    excludeAltBuffer: true,
    excludeModes: true
  })
}
