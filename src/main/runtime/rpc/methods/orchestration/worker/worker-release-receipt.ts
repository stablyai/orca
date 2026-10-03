import type {
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../../../orchestration/worker-terminal-ownership'
import { decideWorkerTerminalRelease } from '../../../../orchestration/worker-terminal-ownership'
import { archiveSummary } from './worker-terminal-resource-presentation'

export type WorkerReleaseReceipt = {
  dispatchId: string
  state: 'released' | 'already_released' | 'retained' | 'release_pending' | 'release_unknown'
  reason?: WorkerTerminalRetainedReason
  processAction: 'closed_agent_terminal' | 'closed_exited_terminal' | 'none'
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
}

export function releaseUnknownRecovery(dispatchId: string): string {
  return `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then retry worker-release with a fresh request ID (omit --retry-request to let the CLI generate one). Reusing the prior request ID only replays this release_unknown receipt. Never substitute a broad terminal close.`
}

export function releasePendingRecovery(): string {
  return 'The recorded terminal has not been rediscovered yet; recovery will retry after the next terminal inventory.'
}

// Ownership guards take precedence over release progress when projecting a raced row.
export function workerReleaseReceiptFromResource(
  dispatchId: string,
  resource: WorkerTerminalResourceRow
): WorkerReleaseReceipt {
  const decision = decideWorkerTerminalRelease(resource)
  const base = {
    dispatchId,
    processAction: 'none' as const,
    archive: archiveSummary(resource)
  }
  if (decision.action === 'already_released') {
    return { ...base, state: 'already_released' }
  }
  if (decision.action === 'retained') {
    return { ...base, state: 'retained', reason: decision.reason }
  }
  if (resource.release_state === 'unknown') {
    return {
      ...base,
      state: 'release_unknown',
      ...(resource.release_error ? { lastError: resource.release_error } : {}),
      recovery: releaseUnknownRecovery(dispatchId)
    }
  }
  if (resource.release_state === 'requested' || resource.release_state === 'releasing') {
    return {
      ...base,
      state: 'release_pending',
      ...(resource.release_error ? { lastError: resource.release_error } : {}),
      recovery: releasePendingRecovery()
    }
  }
  return { ...base, state: 'retained', reason: retainedReason(resource) }
}

export function retainedReason(resource: WorkerTerminalResourceRow): WorkerTerminalRetainedReason {
  if (resource.retained_reason) {
    return resource.retained_reason as WorkerTerminalRetainedReason
  }
  if (resource.ownership_state === 'user_owned') {
    return 'user_takeover'
  }
  return 'identity_unproven'
}
