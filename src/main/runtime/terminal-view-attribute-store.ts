/** Cache global renderer color/cursor attributes; per-pane font zoom does not affect them.
 * Before first push, hidden OSC 4/12 and ?996n queries stay silent. Current PTY owners answer OSC 10/11 from viewer colors.
 * One IPC hop bounds staleness; renderer-owned 2031/997 flips correct subscribed TUIs. */
import {
  terminalViewAttributesEqual,
  terminalViewColorQueryReplyColors,
  type TerminalViewAttributes
} from '../../shared/terminal-view-attributes'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
import { colorQueryReplyColorsEqual } from '../../shared/pty-owner-color-query-colors'

// IPC stores shared attributes; runtime emulators read them at reply time.
let currentAttributes: TerminalViewAttributes | null = null

// All panes share viewer colors; use this host's window, or paired-client push on a headless host.
let pairedViewerColors: TerminalOscColorQueryReplyColors | null = null
let seedColors: TerminalOscColorQueryReplyColors | null = null
let viewerColorsListener: ((colors: TerminalOscColorQueryReplyColors) => void) | null = null

// Push to existing emulators too: replay-guarded cursor options and OSC overlay reset on changed themes.
type TerminalViewAttributesApplier = (attributes: TerminalViewAttributes) => void
const pushAppliers = new Set<TerminalViewAttributesApplier>()

export function registerTerminalViewAttributesApplier(
  applier: TerminalViewAttributesApplier
): void {
  pushAppliers.add(applier)
}

/** Accept validated IPC attributes; replies use the latest changed push. */
export function setTerminalViewAttributes(attributes: TerminalViewAttributes): void {
  // Renderer dedupe is per-process; identical reload/activation pushes are not theme applies and must not wipe OSC SET overlays.
  if (currentAttributes && terminalViewAttributesEqual(currentAttributes, attributes)) {
    return
  }
  const before = getTerminalViewerColors()
  currentAttributes = attributes
  for (const applier of pushAppliers) {
    applier(attributes)
  }
  notifyIfViewerColorsChanged(before)
}

export function getTerminalViewAttributes(): TerminalViewAttributes | null {
  return currentAttributes
}

export function getTerminalViewColorQueryReplyColors(): TerminalOscColorQueryReplyColors | null {
  return currentAttributes ? terminalViewColorQueryReplyColors(currentAttributes) : null
}

/** The colours OSC 10/11 answer with on this host: its own window, else a paired client, else
 *  the saved theme. */
export function getTerminalViewerColors(): TerminalOscColorQueryReplyColors | null {
  return getTerminalViewColorQueryReplyColors() ?? pairedViewerColors ?? seedColors
}

/** A paired client's theme, from terminal.setViewerColors or the colours on terminal.create. */
export function setPairedViewerColors(colors: TerminalOscColorQueryReplyColors): void {
  const before = getTerminalViewerColors()
  pairedViewerColors = colors
  notifyIfViewerColorsChanged(before)
}

/** The saved theme, answering until a viewer reports its colours. */
export function seedTerminalViewerColors(colors: TerminalOscColorQueryReplyColors): void {
  const before = getTerminalViewerColors()
  seedColors = colors
  notifyIfViewerColorsChanged(before)
}

function notifyIfViewerColorsChanged(before: TerminalOscColorQueryReplyColors | null): void {
  const colors = getTerminalViewerColors()
  if (colors && !colorQueryReplyColorsEqual(before, colors)) {
    viewerColorsListener?.(colors)
  }
}

/** One listener: the PTY IPC layer re-installs it on macOS re-activation. */
export function setTerminalViewerColorsListener(
  listener: ((colors: TerminalOscColorQueryReplyColors) => void) | null
): void {
  viewerColorsListener = listener
}

/** Test seam: reset module state between tests. */
export function _resetTerminalViewAttributesForTest(): void {
  currentAttributes = null
  pushAppliers.clear()
  pairedViewerColors = null
  seedColors = null
  viewerColorsListener = null
}
