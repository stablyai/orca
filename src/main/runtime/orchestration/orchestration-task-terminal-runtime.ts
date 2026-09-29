import { describeUnconfirmedStop } from '../../../shared/pty-liveness-verdict'
import type { OrcaRuntimeService } from '../orca-runtime'
import { releaseFederatedWorker } from '../rpc/methods/orchestration/federation/federated-worker-release'
import {
  resolveStructuredWorkerForDispatch,
  stopStructuredWorker
} from '../rpc/methods/orchestration-structured-worker-lifecycle'
import {
  inspectWorkerTerminal,
  resolvePinnedFederatedServer
} from '../rpc/methods/orchestration/worker/worker-observation'
import type { OrchestrationDb } from './db'
import type { OrchestrationTaskTerminalEvent } from './orchestration-task-terminal-event'
import {
  teardownOrchestrationTaskTerminal,
  type TaskTerminalTeardownPorts
} from './orchestration-task-terminal-teardown'

export async function runBoundOrchestrationTaskTerminalTeardown(
  runtime: object,
  event: OrchestrationTaskTerminalEvent
): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bindOrchestrationTaskTerminalTeardown is only called with the live OrcaRuntimeService.
  const host = runtime as OrcaRuntimeService
  const db = host.getOrchestrationDb()
  await teardownOrchestrationTaskTerminal(db, event, portsForRuntime(host, db))
}

function portsForRuntime(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb
): TaskTerminalTeardownPorts {
  return {
    inspect: async (dispatchId) => {
      const observed = await inspectWorkerTerminal(runtime, db, dispatchId)
      return {
        status: observed.status,
        ...(observed.reason ? { reason: observed.reason } : {}),
        terminalHandle: observed.terminalHandle
      }
    },
    closeTerminal: (handle) => runtime.closeTerminal(handle),
    stopStructured: async (dispatchId) => {
      const structured = resolveStructuredWorkerForDispatch(db, dispatchId)
      if (!structured) {
        return { stopped: false, reason: 'Structured worker identity was not found.' }
      }
      const stop = await stopStructuredWorker(structured, dispatchId, runtime)
      return { stopped: stop.stopped, ...(stop.reason ? { reason: stop.reason } : {}) }
    },
    releaseFederated: (dispatchId) => releaseFederatedDispatch(runtime, db, dispatchId),
    readWorktreeComment: async (worktreeId) => {
      try {
        const worktree = await runtime.showManagedWorktree(`id:${worktreeId}`)
        return worktree.comment ?? ''
      } catch {
        return ''
      }
    },
    applyWorkspace: async (worktreeId, update) => {
      await runtime.updateManagedWorktreeMeta(`id:${worktreeId}`, update)
    }
  }
}

async function releaseFederatedDispatch(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string
): Promise<{ provedExited: boolean; error: string | null }> {
  const federated = db.getFederatedDispatch(dispatchId)
  if (!federated) {
    return { provedExited: true, error: null }
  }
  try {
    const receipt = await releaseFederatedWorker({
      runtime,
      server: resolvePinnedFederatedServer(runtime, federated),
      federated,
      dispatchId,
      requestId: `task-terminal-teardown:${dispatchId}`
    })
    if (
      (receipt.state === 'released' || receipt.state === 'already_released') &&
      !receipt.lastError
    ) {
      return { provedExited: true, error: null }
    }
    return {
      provedExited: false,
      error: describeUnconfirmedStop(
        receipt.lastError ?? receipt.recovery ?? `remote release returned ${receipt.state}`
      )
    }
  } catch (error) {
    return {
      provedExited: false,
      error: describeUnconfirmedStop(error instanceof Error ? error.message : String(error))
    }
  }
}
