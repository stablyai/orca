import type { SerializeAddon } from '@xterm/addon-serialize'
import type { Terminal } from '@xterm/headless'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { buildFrameRestoreSnapshotFields } from './terminal-frame-restore-sequences'
import { collectHeadlessOscLinkRanges } from './headless-osc-link-ranges'
import { splitTerminalSnapshotAnsi } from './terminal-snapshot-ansi-buffers'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from '../../shared/terminal-serialize-absolute-cursor'
import type { TerminalModes, TerminalSnapshot } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

/**
 * Snapshot assembly for HeadlessEmulator, memoized on a mutation epoch.
 *
 * Why: attaching a viewer serializes the session's whole buffer synchronously
 * on the daemon event loop, so every reattach of a quiescent session paid to
 * re-serialize identical bytes (measured 253-281ms per session). The cache is
 * keyed on an epoch the emulator bumps on every state mutation, so a hit is
 * byte-identical by construction rather than merely fresh-enough.
 */
type CachedParts = {
  snapshotAnsi: string
  scrollbackAnsi: string
  oscLinks: TerminalOscLinkRange[]
  frameRestore: ReturnType<typeof buildFrameRestoreSnapshotFields>
  modes: TerminalModes
  rehydrateSequences: ReturnType<typeof buildRehydrateSequences>
}

// Why a cap: an entry is retained for the session's lifetime once the session
// goes quiescent — exactly the parked case this optimizes. A 5k-row buffer
// serializes to a few hundred KB, but a renderer may ask for 50k rows, so an
// uncapped cache would retain tens of MB per session. Oversized payloads still
// serve correctly, they just re-serialize instead of being retained.
// Bytes, not chars, to match the daemon's other retention cap
// (MAX_COLD_RESTORE_CACHE_BYTES) so the two budgets read in one unit.
const MAX_CACHED_SNAPSHOT_BYTES = 4 * 1024 * 1024

/** Distinct scrollback windows retained per emulator. */
const MAX_CACHED_SNAPSHOT_WINDOWS = 2

// Why code units: bounds V8 string storage without rescanning or flattening
// multi-MB ropes — same sizing rule as getColdRestorePayloadBytes.
function retainedSnapshotBytes(parts: CachedParts): number {
  return (parts.snapshotAnsi.length + parts.scrollbackAnsi.length) * 2
}

export type HeadlessSnapshotSource = {
  serializer: SerializeAddon
  terminal: Terminal
  restoredOscLinks: TerminalOscLinkRange[]
  readModes: () => TerminalModes
  cwd: string | null
  lastTitle: string | null | undefined
  partialEscapeTail: string
}

export class HeadlessSnapshotCache {
  // Why keyed and not a single slot: consumers ask for different scrollback
  // windows against the same emulator — attach passes the full window while
  // agent/text reads pass 0 — and one slot thrashes to a 0% hit rate when they
  // alternate. Two covers every caller pair in the tree; a third evicts the
  // oldest rather than growing per emulator.
  private readonly entries = new Map<number | undefined, CachedParts>()

  /** Invalidates the cache. Called for every mutation of a memoized part;
   *  fields build() re-reads per call (cwd, lastTitle, escape tail) do not. */
  markMutated(): void {
    this.entries.clear()
  }

  /** Builds a caller-owned snapshot, reusing the memoized serialize on a hit. */
  build(source: HeadlessSnapshotSource, scrollbackRows: number | undefined): TerminalSnapshot {
    let parts = this.entries.get(scrollbackRows)
    if (!parts) {
      parts = computeCachedParts(source, scrollbackRows)
      // Why size-gated: see MAX_CACHED_SNAPSHOT_BYTES. Declining to retain costs
      // the pre-existing serialize, never correctness.
      if (retainedSnapshotBytes(parts) <= MAX_CACHED_SNAPSHOT_BYTES) {
        if (this.entries.size >= MAX_CACHED_SNAPSHOT_WINDOWS) {
          const oldest = this.entries.keys().next()
          if (!oldest.done) {
            this.entries.delete(oldest.value)
          }
        }
        this.entries.set(scrollbackRows, parts)
      }
    }
    // Why cloned: a hit hands back the retained entry, so a caller mutating
    // its snapshot would otherwise corrupt every later one.
    const modes = { ...parts.modes }
    return {
      snapshotAnsi: parts.snapshotAnsi,
      scrollbackAnsi: parts.scrollbackAnsi,
      oscLinks: parts.oscLinks.map((link) => ({ ...link })),
      rehydrateSequences: parts.rehydrateSequences,
      ...parts.frameRestore,
      cwd: source.cwd,
      modes,
      cols: source.terminal.cols,
      rows: source.terminal.rows,
      scrollbackLines: source.terminal.buffer.normal.length - source.terminal.rows,
      lastTitle: source.lastTitle ?? undefined,
      // Why written LAST by the restorer: the next live chunk must complete this dangling sequence, not render it literally (Bug E / #7329).
      ...(source.partialEscapeTail.length > 0
        ? { pendingEscapeTailAnsi: source.partialEscapeTail }
        : {})
    }
  }
}

function computeCachedParts(
  source: HeadlessSnapshotSource,
  scrollbackRows: number | undefined
): CachedParts {
  const modes = source.readModes()
  // Why absolute: relative cursor restore is off by a column after a wrap-pending final row; saved-cursor rides along for DECRC.
  const serializedAnsi = serializeWithAbsoluteCursor(
    source.serializer,
    source.terminal,
    { scrollback: scrollbackRows },
    readSavedCursorRegister(source.terminal)
  )
  return {
    ...splitTerminalSnapshotAnsi(serializedAnsi, modes),
    oscLinks: collectHeadlessOscLinkRanges(
      source.terminal,
      scrollbackRows,
      source.restoredOscLinks
    ),
    frameRestore: buildFrameRestoreSnapshotFields(source.serializer, source.terminal, modes),
    modes,
    rehydrateSequences: buildRehydrateSequences(modes)
  }
}
