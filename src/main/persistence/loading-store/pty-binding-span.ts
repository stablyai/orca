import { startSpan } from '../../observability/tracer'
import type { PtyBindingFastLaneMiss } from './pty-binding-fast-lane'

export type PtyBindingSpanOutcome = 'fast_lane' | 'flushed' | 'refused' | 'threw'

/**
 * Fast-lane hits are the frequent, cheap case and the one a reattach storm could flood the trace
 * file with. Everything else is always recorded. A heavy switching session binds tens of times a
 * minute, so a real session should never saturate; the span that spends the last budget slot
 * carries `binding.sampled: true` so a reader can tell when later hits in that window were dropped.
 */
export const PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW = 200
const FAST_LANE_WINDOW_MS = 60_000

let fastLaneWindow: { startMs: number; emitted: number } | null = null

function admitFastLaneSpan(nowMs: number): {
  record: boolean
  lastInWindow: boolean
} {
  if (!fastLaneWindow || nowMs - fastLaneWindow.startMs >= FAST_LANE_WINDOW_MS) {
    fastLaneWindow = { startMs: nowMs, emitted: 0 }
  }
  if (fastLaneWindow.emitted >= PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW) {
    return { record: false, lastInWindow: false }
  }
  fastLaneWindow.emitted += 1
  return {
    record: true,
    lastInWindow: fastLaneWindow.emitted === PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW
  }
}

export type PtyBindingSpan = {
  setEligibility(verdict: { eligible: boolean; misses: readonly PtyBindingFastLaneMiss[] }): void
  setFlushed(flushed: boolean): void
  finish(outcome: PtyBindingSpanOutcome, error?: unknown): void
}

/**
 * One `persistence.pty-binding` span per `persistPtyBinding` call. Attributes are all
 * low-cardinality on purpose: no pane key, PTY id, worktree id, path, or SSH target id ever lands
 * in the trace file. A local-only NDJSON lane, collected only into a user-submitted bundle.
 */
export function startPtyBindingSpan(entry: {
  hostKind: 'local' | 'ssh'
  savePending: boolean
  generationGap: number
}): PtyBindingSpan {
  let dropped = false
  const span = startSpan('persistence.pty-binding', {
    attributes: {
      kind: 'persistence',
      'binding.host': entry.hostKind,
      'binding.save_pending': entry.savePending,
      'binding.generation_gap': entry.generationGap,
      'binding.flushed': false
    },
    shouldRecord: () => !dropped
  })
  return {
    setEligibility(verdict) {
      span.setAttribute('binding.eligible', verdict.eligible)
      span.setAttribute('binding.misses', verdict.misses.join(','))
    },
    setFlushed(flushed) {
      span.setAttribute('binding.flushed', flushed)
    },
    finish(outcome, error) {
      span.setAttribute('binding.outcome', outcome)
      if (outcome === 'fast_lane') {
        const admission = admitFastLaneSpan(Date.now())
        dropped = !admission.record
        if (admission.lastInWindow) {
          span.setAttribute('binding.sampled', true)
        }
      }
      if (outcome === 'threw') {
        span.fail(error instanceof Error ? error : String(error))
        return
      }
      span.end()
    }
  }
}

export function _resetPtyBindingSpanSamplingForTests(): void {
  fastLaneWindow = null
}
