import { startSpan } from '../../observability/tracer'
import type { PtyBindingFastLaneMiss } from './pty-binding-fast-lane'
import {
  terminalPanePlacementAgreement,
  type TerminalPanePlacementAgreement
} from '../terminal-topology/terminal-pane-placement-agreement'
import {
  findTerminalBindingConflict,
  type TerminalOwnerConflictReason
} from '../../../shared/workspace-layout/terminal-owner-invariants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export type PtyBindingPath = 'durable_match' | 'durability_only' | 'mutation'

export type PtyBindingSpanOutcome = 'fast_lane' | 'flushed' | 'refused' | 'threw'

/** Tracing-only origin separates reattach hit rates from fresh spawns, which always flush. */
export type PtyBindingOrigin = 'reattach' | 'spawn' | 'relay_reattach' | 'split' | 'unknown'

export type PtySpawnCommitOrigin = Extract<PtyBindingOrigin, 'reattach' | 'spawn' | 'split'>

export function spawnCommitBindingOrigin(
  commit: { isReattach?: boolean; agentSessionEnsure?: { disposition: string } },
  expectedSourceBinding?: unknown
): PtySpawnCommitOrigin {
  if (expectedSourceBinding !== undefined) {
    return 'split'
  }
  return commit.isReattach === true || commit.agentSessionEnsure?.disposition === 'adopted'
    ? 'reattach'
    : 'spawn'
}

// Cap successful match traces; always record mutations, refusals and failures.
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
  setPath(path: PtyBindingPath): void
  setPlacement(agreement: TerminalPanePlacementAgreement): void
  /** Report-only: invariant failures do not block binding writes. */
  setOwnerConflict(reason: TerminalOwnerConflictReason | 'check_threw'): void
  finish(outcome: PtyBindingSpanOutcome, error?: unknown): void
}

/** Exclude pane/PTY/worktree/target IDs and paths from low-cardinality local traces. */
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
      const path = record.attributes['binding.path']
      const frequentMatch =
        record.attributes['binding.outcome'] === 'fast_lane' ||
        (path === 'durability_only' && record.attributes['binding.outcome'] === 'flushed')
      if (!frequentMatch) {
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
    setPath(path) {
      span.setAttribute('binding.path', path)
    },
    setPlacement(agreement) {
      span.setAttribute('binding.placement', agreement)
    },
    setOwnerConflict(reason) {
      span.setAttribute('binding.owner_conflict', reason)
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

/** Reporting must not turn malformed state into a binding failure. */
export function reportPtyBindingPlacement(
  span: PtyBindingSpan,
  args: { placement?: TerminalPanePlacement; tabId: string; leafId: string },
  session: WorkspaceSessionState,
  worktreeId: string
): void {
  try {
    span.setPlacement(
      terminalPanePlacementAgreement(args.placement, session, worktreeId, args.tabId, args.leafId)
    )
  } catch {
    span.setPlacement('check_threw')
  }
}

/** Record invariant failures without refusing the binding. */
export function reportPtyBindingOwnerConflict(
  span: PtyBindingSpan,
  binding: Parameters<typeof findTerminalBindingConflict>[0],
  hostId: ExecutionHostId,
  partitions: Parameters<typeof findTerminalBindingConflict>[2]
): void {
  try {
    const conflict = findTerminalBindingConflict(binding, hostId, partitions)
    if (conflict) {
      span.setOwnerConflict(conflict.reason)
    }
  } catch {
    span.setOwnerConflict('check_threw')
  }
}
