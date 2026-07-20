/**
 * Phase 5 slice 2 (View-attribute bridge): main-side cache of the renderer's
 * `pty:terminalViewAttributes`
 * push. One app-global snapshot, not per-PTY — per-pane font zoom never
 * affects these attributes and the color/cursor settings are global.
 *
 * Null until the first push, and the responder answers NO view-attribute
 * query while null (silent-until-first-push): a fabricated default would
 * resurrect the default-black OSC-11 bug. Staleness is bounded by one IPC
 * hop; subscribed TUIs are corrected by the renderer-owned 2031/997 flip.
 */
import {
  terminalViewAttributesEqual,
  type TerminalViewAttributes
} from '../../shared/terminal-view-attributes'

// Why module state (pattern of pty-hidden-delivery-gate.ts): pty.ts receives
// the push, the runtime emulators consult it at reply time via the getter.
let currentAttributes: TerminalViewAttributes | null = null

// Why appliers (pattern of registerConptyDa1OverrideInstaller): each push
// must also reach already-live emulators — cursor options under the replay
// guard, plus the per-PTY override reset a theme apply implies.
type TerminalViewAttributesApplier = (attributes: TerminalViewAttributes) => void
const pushAppliers = new Set<TerminalViewAttributesApplier>()

export function registerTerminalViewAttributesApplier(
  applier: TerminalViewAttributesApplier
): void {
  pushAppliers.add(applier)
}

/** Called from the pty:terminalViewAttributes IPC handler with a validated
 *  payload. Last push wins (replies always use the freshest snapshot). */
export function setTerminalViewAttributes(attributes: TerminalViewAttributes): void {
  // Why idempotent: the renderer publisher's dedupe is per-process, so a
  // fresh renderer (second window, reload, macOS re-activation) re-pushes
  // identical attributes. That is not a theme apply — fanning out would wipe
  // every PTY's OSC SET overlay while visible panes keep theirs.
  if (currentAttributes && terminalViewAttributesEqual(currentAttributes, attributes)) {
    return
  }
  currentAttributes = attributes
  for (const applier of pushAppliers) {
    applier(attributes)
  }
}

export function getTerminalViewAttributes(): TerminalViewAttributes | null {
  return currentAttributes
}

/** Test seam: reset module state between tests. */
export function _resetTerminalViewAttributesForTest(): void {
  currentAttributes = null
  pushAppliers.clear()
}
