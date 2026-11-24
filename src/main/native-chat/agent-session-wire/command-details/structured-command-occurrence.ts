// One live Codex command start, as the tracker accepted it. Process-only: never on the wire, never
// serialized, never in a queued closure. Queued edges reach it only through a WeakRef.

import type { AgentChildWorkLiveObservation } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'

export type StructuredCommandOccurrence = {
  /** False once the tracker ends or clears the command, independent of GC. */
  active: boolean
  /** The final display/Copy value, or null when the start was not proven exact. */
  display: string | null
  /** A trusted live admission of this occurrence succeeded; only the first can attach. */
  seen: boolean
  /** Deny-only and sticky: its own resolution saw a retired, pre-existing or ambiguous identity. */
  retirementObserved: boolean
}

export function createStructuredCommandOccurrence(
  display: string | null
): StructuredCommandOccurrence {
  return { active: true, display, seen: false, retirementObserved: false }
}

export function endStructuredCommandOccurrence(occurrence: StructuredCommandOccurrence): void {
  occurrence.active = false
  occurrence.display = null
}

const evidenceOccurrences = new WeakMap<object, WeakRef<StructuredCommandOccurrence>>()

/** Ties a drained live observation to the occurrence that produced it, without holding either. */
export function markLiveEvidenceOccurrence(
  observation: AgentChildWorkLiveObservation,
  occurrence: WeakRef<StructuredCommandOccurrence>
): void {
  evidenceOccurrences.set(observation, occurrence)
}

/** The still-active occurrence behind this observation, dereferenced in the admitting stack. */
export function liveEvidenceOccurrence(
  observation: AgentChildWorkLiveObservation
): StructuredCommandOccurrence | null {
  const occurrence = evidenceOccurrences.get(observation)?.deref()
  return occurrence?.active ? occurrence : null
}
