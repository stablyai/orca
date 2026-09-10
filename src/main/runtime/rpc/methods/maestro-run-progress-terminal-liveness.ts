import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { MaestroTerminalLiveness } from '../../orchestration/maestro-run-resource-state'
import { inspectWorkerTerminal } from './orchestration/worker/worker-observation'

const TERMINAL_LIVENESS_CONCURRENCY = 8

export async function observeMaestroTerminalLiveness(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  leases: readonly MaestroTerminalLease[]
): Promise<ReadonlyMap<string, MaestroTerminalLiveness>> {
  const observations = await mapWithConcurrency(
    leases,
    TERMINAL_LIVENESS_CONCURRENCY,
    async (lease) => [lease.id, await observeLease(runtime, db, lease)] as const
  )
  return new Map(observations)
}

async function observeLease(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  lease: MaestroTerminalLease
): Promise<MaestroTerminalLiveness> {
  if (lease.cleanupReceipt) {
    return lease.cleanupReceipt.verdict
  }
  if (lease.lifecycleState === 'outcome_unknown') {
    return 'unverifiable'
  }
  const dispatchId = workerDispatchId(lease)
  if (dispatchId) {
    const observation = await inspectWorkerTerminal(runtime, db, dispatchId)
    if (!observation.terminal || !terminalMatchesLease(runtime, lease, observation.terminal)) {
      return 'unverifiable'
    }
    const verdict = runtime.getTerminalLivenessVerdict(lease.terminalHandle as string)
    if (verdict) {
      return verdict.status
    }
    return observation.status === 'live' && lease.executionHostId === 'local'
      ? 'live'
      : 'unverifiable'
  }
  return observeCoordinatorTerminal(runtime, lease)
}

function workerDispatchId(lease: MaestroTerminalLease): string | null {
  return lease.role === 'worker' && lease.ownerPrincipal.startsWith('dispatch:')
    ? lease.ownerPrincipal.slice('dispatch:'.length)
    : null
}

async function observeCoordinatorTerminal(
  runtime: OrcaRuntimeService,
  lease: MaestroTerminalLease
): Promise<MaestroTerminalLiveness> {
  if (!lease.terminalHandle || !lease.tabId || !lease.paneKey || !lease.ptyIncarnation) {
    return 'unverifiable'
  }
  const terminal = await runtime.showTerminal(lease.terminalHandle).catch(() => null)
  if (!terminal) {
    return 'unverifiable'
  }
  if (!terminalMatchesLease(runtime, lease, terminal)) {
    return 'unverifiable'
  }
  const verdict = runtime.getTerminalLivenessVerdict(lease.terminalHandle)
  if (verdict) {
    return verdict.status
  }
  if (lease.executionHostId !== 'local') {
    return 'unverifiable'
  }
  return terminal.connected === false ? 'unverifiable' : 'live'
}

function terminalMatchesLease(
  runtime: OrcaRuntimeService,
  lease: MaestroTerminalLease,
  terminal: Awaited<ReturnType<OrcaRuntimeService['showTerminal']>>
): boolean {
  if (!lease.terminalHandle || !lease.tabId || !lease.paneKey || !lease.ptyIncarnation) {
    return false
  }
  const workspaceKey = parseWorkspaceKey(terminal.worktreeId)
    ? terminal.worktreeId
    : worktreeWorkspaceKey(terminal.worktreeId)
  return (
    terminal.tabId === lease.tabId &&
    workspaceKey === lease.workspaceKey &&
    runtime.getTerminalPaneKey(lease.terminalHandle) === lease.paneKey &&
    runtime.getTerminalProcessIncarnation(lease.terminalHandle) === lease.ptyIncarnation
  )
}
