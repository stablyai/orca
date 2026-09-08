import { startSpan } from '../../observability/tracer'
import type { PtyBindingFastLaneMiss } from './pty-binding-fast-lane'

export type PtyBindingSpanOutcome = 'fast_lane' | 'flushed' | 'refused' | 'threw'

/**
 * Who asked for the bind. `persistPtyBinding` cannot tell a fresh spawn from a warm remount, and
 * fresh spawns always flush, so a rate over all calls understates the reattach hit rate. Metadata
 * only: nothing in the write path may branch on it.
 */
export type PtyBindingOrigin = 'reattach' | 'spawn' | 'relay_reattach' | 'split' | 'unknown'

/** The spawn-commit paths share one rule: a split outranks a reattach, a reattach outranks a spawn. */
export function spawnCommitBindingOrigin(
  commit: { isReattach?: boolean },
  expectedSourceBinding?: unknown
): PtyBindingOrigin {
  if (expectedSourceBinding !== undefined) {
    return 'split'
  }
  return commit.isReattach === true ? 'reattach' : 'spawn'
}

// Bound frequent no-op traces; writes, refusals, and failures are always recorded.
export const PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW = 200
const FAST_LANE_WINDOW_MS = 60_000

let fastLaneWindow: { startMs: number; emitted: number } | null = null

function admitFastLaneSpan(nowMs: number): boolean {
  if (!fastLaneWindow || nowMs - fastLaneWindow.startMs >= FAST_LANE_WINDOW_MS) {
    fastLaneWindow = { startMs: nowMs, emitted: 0 }
  }
  if (fastLaneWindow.emitted >= PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW) {
    return false
  }
  fastLaneWindow.emitted += 1
  return true
}

export type PtyBindingSpan = {
  setEligibility(verdict: { eligible: boolean; misses: readonly PtyBindingFastLaneMiss[] }): void
  finish(outcome: PtyBindingSpanOutcome, error?: unknown): void
}

/**
 * One `persistence.pty-binding` span per `persistPtyBinding` call. Attributes are all
 * low-cardinality on purpose: no pane key, PTY id, worktree id, path, or SSH target id ever lands
 * in the trace file. A local-only NDJSON lane, collected only into a user-submitted bundle.
 */
export function startPtyBindingSpan(entry: {
  hostKind: 'local' | 'ssh' | 'runtime'
  origin: PtyBindingOrigin
  savePending: boolean
  generationGap: number
}): PtyBindingSpan {
  const span = startSpan('persistence.pty-binding', {
    attributes: {
      kind: 'persistence',
      'binding.host': entry.hostKind,
      'binding.origin': entry.origin,
      'binding.save_pending': entry.savePending,
      'binding.generation_gap': entry.generationGap
    },
    shouldRecord(record) {
      if (record.attributes['binding.outcome'] !== 'fast_lane') {
        return true
      }
      return admitFastLaneSpan(Date.now())
    }
  })
  return {
    setEligibility(verdict) {
      span.setAttribute('binding.eligible', verdict.eligible)
      span.setAttribute('binding.misses', verdict.misses.join(','))
    },
    finish(outcome, error) {
      span.setAttribute('binding.outcome', outcome)
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
