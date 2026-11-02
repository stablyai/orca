import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  attachMutationReplayNudge,
  type MutationReplayNudge
} from '../../../orchestration-mutation-receipt'

/** Persists the receipt (with its replay nudge) before waking recipients, for mutations whose effect is already durable. */
export function recordReceiptBeforeNudge<T>(
  recordMutationReceipt: ((receipt: unknown) => void) | undefined,
  receipt: T,
  nudge: () => void,
  replayNudge: MutationReplayNudge | undefined = messageReplayNudge(receipt)
): T {
  recordMutationReceipt?.(replayNudge ? attachMutationReplayNudge(receipt, replayNudge) : receipt)
  nudge()
  return receipt
}

/** Same, but hands the nudge back so the caller can fire it after its enclosing transaction commits. */
export function recordReceiptForPostCommitNudge<T>(
  recordMutationReceipt: ((receipt: unknown) => void) | undefined,
  receipt: T,
  nudge: () => void,
  replayNudge: MutationReplayNudge | undefined = messageReplayNudge(receipt)
): { receipt: T; nudge: () => void } {
  recordMutationReceipt?.(replayNudge ? attachMutationReplayNudge(receipt, replayNudge) : receipt)
  return { receipt, nudge }
}

export function messageReplayNudge(receipt: unknown): MutationReplayNudge | undefined {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return undefined
  }
  const source = receipt as { message?: unknown; messages?: unknown }
  const rows = source.message
    ? [source.message]
    : Array.isArray(source.messages)
      ? source.messages
      : []
  const targets = rows.flatMap((row) => {
    if (!row || typeof row !== 'object') {
      return []
    }
    const candidate = row as { to_handle?: unknown; type?: unknown }
    return typeof candidate.to_handle === 'string' && typeof candidate.type === 'string'
      ? [{ to: candidate.to_handle, type: candidate.type }]
      : []
  })
  return targets.length === rows.length && targets.length > 0
    ? { kind: 'messages', targets }
    : undefined
}

export function replayMutationNudge(
  runtime: OrcaRuntimeService,
  replayNudge: MutationReplayNudge
): void {
  if (replayNudge.kind === 'federation') {
    runtime.ensureOrchestrationFederationRelay(replayNudge.runId)
    return
  }
  for (const target of replayNudge.targets) {
    runtime.notifyMessageArrived(target.to, target.type)
  }
}
