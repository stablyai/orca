import {
  terminalViewAttributesEqual,
  validateTerminalViewAttributes,
  type TerminalViewAttributes
} from '../../shared/terminal-view-attributes'

// Why module state (pattern of setPtyOwnerHostColors): one viewer snapshot answers for every
// session this daemon owns, and a delegated responder reads it at reply time.
let viewAttributes: TerminalViewAttributes | null = null
const appliers = new Set<(attributes: TerminalViewAttributes) => void>()

/** Main's push of the renderer's view attributes (v45+); malformed payloads are dropped. */
export function setDaemonTerminalViewAttributes(payload: unknown): void {
  const attributes = validateTerminalViewAttributes(payload)
  // Why idempotent: a reconnect re-pushes the same attributes, which is not a theme apply and
  // must not wipe the per-session OSC SET overlays.
  if (!attributes || (viewAttributes && terminalViewAttributesEqual(viewAttributes, attributes))) {
    return
  }
  viewAttributes = attributes
  for (const apply of appliers) {
    apply(attributes)
  }
}

export function getDaemonTerminalViewAttributes(): TerminalViewAttributes | null {
  return viewAttributes
}

export function onDaemonTerminalViewAttributes(
  apply: (attributes: TerminalViewAttributes) => void
): () => void {
  appliers.add(apply)
  return () => appliers.delete(apply)
}

export function _resetDaemonTerminalViewAttributesForTest(): void {
  viewAttributes = null
  appliers.clear()
}
