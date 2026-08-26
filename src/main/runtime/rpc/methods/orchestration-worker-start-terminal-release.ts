import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { requireWorkerAuthority, type WorkerEffect } from './orchestration-worker-topology'
import { completeWorkerTerminalRelease } from './orchestration-worker-release-completion'

export function attachExitedWorkerTerminalAuthority(
  runtime: OrcaRuntimeService,
  args: {
    db: OrchestrationDb
    dispatchId: string
    terminalHandle: string
    worktreeId: string
    effects: WorkerEffect[]
    setup: { state: string }
  }
): void {
  const authority = requireWorkerAuthority(runtime, args.terminalHandle)
  args.db.prepareStartingWorkerAuthority({
    dispatchId: args.dispatchId,
    handle: args.terminalHandle,
    ...authority,
    worktreeId: args.worktreeId,
    effects: args.effects,
    setupState: args.setup.state,
    terminalOwnership: 'created'
  })
}

export async function releaseFailedWorkerStartTerminal(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  failedStage: string
  failure: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  try {
    const requested = args.db.requestWorkerTerminalRelease(args.dispatchId)
    if (requested.disposition !== 'requested') {
      return args.failure
    }
    const release = await completeWorkerTerminalRelease({
      runtime: args.runtime,
      db: args.db,
      dispatchId: args.dispatchId,
      resource: requested.resource
    })
    if (release.state !== 'released') {
      return args.failure
    }
    const residualResources = (args.failure.residualResources as WorkerEffect[]).filter(
      (effect) => effect.kind !== 'terminal' || effect.id !== requested.resource.terminal_handle
    )
    args.db.recordWorkerStage({
      dispatchId: args.dispatchId,
      stage: args.failedStage,
      residualResources
    })
    return { ...args.failure, residualResources }
  } catch {
    return args.failure
  }
}
