/** Cache global renderer color/cursor attributes; per-pane font zoom does not affect them.
 * Before first push, hidden OSC 4/12 and ?996n queries stay silent. Current PTY owners answer OSC 10/11 from viewer colors.
 * One IPC hop bounds staleness; renderer-owned 2031/997 flips correct subscribed TUIs. */
import {
  parseXColorSpec,
  terminalViewAttributesEqual,
  validateTerminalViewAttributes,
  terminalViewColorQueryReplyColors,
  type TerminalViewAttributes,
  type TerminalViewRgb
} from '../../shared/terminal-view-attributes'
import {
  cssColorToOscRgb,
  type TerminalOscColorQueryReplyColors
} from '../../shared/terminal-osc-color-reply'
import {
  colorQueryReplyColorsEqual,
  normalizeColorQueryReplyColors
} from '../../shared/pty-owner-color-query-colors'

// IPC stores shared attributes; runtime emulators read them at reply time.
let currentAttributes: TerminalViewAttributes | null = null

// All panes share viewer colors; use this host's window, or paired-client push on a headless host.
let pairedViewerColors: TerminalOscColorQueryReplyColors | null = null
let pairedAttributes: TerminalViewAttributes | null = null
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

/** What hidden PTYs answer OSC 4/12 and ?996n with: this host's window, else a paired client's. */
export function getTerminalViewAttributes(): TerminalViewAttributes | null {
  return currentAttributes ?? pairedAttributes
}

/** A paired client's full appearance; a host window's own push wins. */
export function setPairedViewAttributes(attributes: TerminalViewAttributes): void {
  if (pairedAttributes && terminalViewAttributesEqual(pairedAttributes, attributes)) {
    return
  }
  pairedAttributes = attributes
  if (currentAttributes) {
    return
  }
  for (const applier of pushAppliers) {
    applier(attributes)
  }
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
  // A colours-only pusher (an older client) has no palette; another client's would contradict these colours.
  if (
    pairedAttributes &&
    !sameColors(terminalViewColorQueryReplyColors(pairedAttributes), colors)
  ) {
    pairedAttributes = null
  }
  notifyIfViewerColorsChanged(before)
}

/** Spawn args that pin a paired creator's theme to its new PTY, whose owner then answers every theme query with it. */
export type PairedLauncherSpawnArgs = {
  launcherColorQueryReplies?: TerminalOscColorQueryReplyColors
  launcherViewAttributes?: TerminalViewAttributes
}

/** Admit terminal.create's theme (older clients report it only there). Pin it only where this host's window outranks
 *  it host-wide (#34340); elsewhere the host-wide theme already is the creator's and follows its later pushes. */
export function admitPairedCreateColors(
  value: unknown,
  attributesValue?: unknown
): PairedLauncherSpawnArgs {
  const colors = normalizeColorQueryReplyColors(value)
  if (!colors) {
    return {}
  }
  const candidate = validateTerminalViewAttributes(attributesValue)
  // A palette for another theme would contradict these colours; an older creator sends none.
  const attributes =
    candidate && sameColors(terminalViewColorQueryReplyColors(candidate), colors) ? candidate : null
  setPairedViewerColors(colors)
  if (attributes) {
    setPairedViewAttributes(attributes)
  }
  if (!currentAttributes) {
    return {}
  }
  return {
    launcherColorQueryReplies: colors,
    ...(attributes ? { launcherViewAttributes: attributes } : {})
  }
}

function cssColorRgb(value: string | undefined): TerminalViewRgb | null {
  return parseXColorSpec(cssColorToOscRgb(value) ?? '')
}

function sameColors(
  a: TerminalOscColorQueryReplyColors,
  b: TerminalOscColorQueryReplyColors
): boolean {
  const key = (colors: TerminalOscColorQueryReplyColors): string =>
    JSON.stringify([cssColorRgb(colors.foreground), cssColorRgb(colors.background)])
  return key(a) === key(b)
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
  pairedAttributes = null
  seedColors = null
  viewerColorsListener = null
}
