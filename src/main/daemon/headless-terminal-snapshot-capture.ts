import type { Terminal } from '@xterm/headless'
import type { SerializeAddon } from '@xterm/addon-serialize'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from '../../shared/terminal-serialize-absolute-cursor'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { collectHeadlessOscLinkRanges } from './headless-osc-link-ranges'
import { readTerminalModes } from './headless-emulator-modes'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { buildFrameRestoreSnapshotFields } from './terminal-frame-restore-sequences'
import { splitTerminalSnapshotAnsi } from './terminal-snapshot-ansi-buffers'
import type { TerminalSnapshot } from './terminal-snapshot'

export function readHeadlessTerminalLines(
  buffer: Terminal['buffer']['active'],
  start: number,
  endExclusive: number
): string[] {
  const lines: string[] = []
  for (let row = start; row < endExclusive; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
  }
  return lines
}

export function captureHeadlessTerminalSnapshot(
  terminal: Terminal,
  serializer: SerializeAddon,
  opts: { scrollbackRows?: number },
  metadata: {
    cwd: string | null
    lastTitle: string | null
    partialEscapeTail: string
    restoredOscLinks: TerminalOscLinkRange[]
  }
): TerminalSnapshot {
  const modes = readTerminalModes(terminal)
  // Why absolute: relative cursor restore is off by a column after a wrap-pending final row; saved-cursor rides along for DECRC.
  const serializedAnsi = serializeWithAbsoluteCursor(
    serializer,
    terminal,
    { scrollback: opts.scrollbackRows },
    readSavedCursorRegister(terminal)
  )
  const { snapshotAnsi, scrollbackAnsi } = splitTerminalSnapshotAnsi(serializedAnsi, modes)
  const snapshot: TerminalSnapshot = {
    snapshotAnsi,
    scrollbackAnsi,
    oscLinks: collectHeadlessOscLinkRanges(
      terminal,
      opts.scrollbackRows,
      metadata.restoredOscLinks
    ),
    rehydrateSequences: buildRehydrateSequences(modes),
    ...buildFrameRestoreSnapshotFields(serializer, terminal, modes),
    cwd: metadata.cwd,
    modes,
    cols: terminal.cols,
    rows: terminal.rows,
    scrollbackLines: terminal.buffer.normal.length - terminal.rows,
    lastTitle: metadata.lastTitle ?? undefined,
    // Why written LAST by the restorer: the next live chunk must complete this dangling sequence, not render it literally (Bug E / #7329).
    ...(metadata.partialEscapeTail.length > 0
      ? { pendingEscapeTailAnsi: metadata.partialEscapeTail }
      : {})
  }
  return snapshot
}
