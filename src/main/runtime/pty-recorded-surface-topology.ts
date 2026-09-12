/**
 * Whether the pane a PTY record names as its surface still exists and still holds it.
 *
 * The incumbent test asked only whether the record agreed with *itself* — `!pty.tabId || !pane
 * || pane.tabId !== pty.tabId`. A record whose `paneKey` still parses to its own `tabId` passes
 * that forever, including after the graph dropped the pane, so a terminal that had lost its
 * surface was reported `orphaned: false` with a `tabId` no tab has: field-for-field identical to
 * a healthy one (#18191). Self-consistency is not topology; the leaf map is.
 *
 * An absence only counts against a record that a graph statement had the standing to contradict,
 * which is what `graphSequence` decides. Every graph statement re-records the surface of every
 * pane it publishes, so a pane the current graph holds always carries the current sequence and
 * is answered without consulting the leaf map at all. That leaves two cases the sequence handles
 * on its own, and neither needs a separate "is the graph usable" flag:
 *
 * - **Nothing has spoken yet.** Before the first sync, and for a surface recorded since the last
 *   one, the stamp is current. Spawn records the renderer's pane identity *before* the graph
 *   carrying it arrives, on purpose (#7587), so the only graph that could have spoken since was
 *   already in flight and its silence is not a retraction.
 * - **The graph went away.** Losing it clears the leaf map wholesale without advancing the
 *   sequence, so every pane it held keeps a current stamp and stays attached. Reading that
 *   emptiness as "no pane holds this" would report every live terminal orphaned at once — the
 *   same lie as #18191, pointed the other way. A pane already observed dropped keeps its stale
 *   stamp and stays named, because losing the ability to re-check is not a reason to un-see it.
 */
import { parsePaneKey } from '../../shared/stable-pane-id'

export type RecordedPtySurface = {
  ptyId: string
  tabId: string | null
  paneKey: string | null
  /** Value of `graphSequence` when this surface was last written. */
  surfaceRecordedAtGraphSequence: number
}

export type PtySurfaceTopology = {
  /** Monotonic count of authoritative graph statements applied so far. */
  graphSequence: number
  /** The ptyId the graph currently binds to this pane, or undefined when it holds no such pane. */
  ptyIdHoldingPane: (tabId: string, leafId: string) => string | null | undefined
}

/**
 * True when the record names a pane the graph agrees this PTY occupies, or when nothing has had
 * the standing to contradict it yet. False is the reportable state: a live PTY with no surface.
 */
export function ptyHoldsRecordedSurface(
  pty: RecordedPtySurface,
  topology: PtySurfaceTopology
): boolean {
  const pane = parsePaneKey(pty.paneKey ?? '')
  if (!pty.tabId || !pane || pane.tabId !== pty.tabId) {
    return false
  }
  if (pty.surfaceRecordedAtGraphSequence >= topology.graphSequence) {
    return true
  }
  return topology.ptyIdHoldingPane(pane.tabId, pane.leafId) === pty.ptyId
}
