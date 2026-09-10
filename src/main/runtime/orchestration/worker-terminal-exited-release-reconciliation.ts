import type { OrcaRuntimeService } from '../orca-runtime'
import type { inspectWorkerTerminal } from '../rpc/methods/orchestration/worker/worker-observation'
import type { OrchestrationDb } from './db'
import { exitedWorkerTerminalLeaseIsCurrent } from './db/worker-terminal/worker-terminal-release-identity'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'

type WorkerTerminalObservation = Awaited<ReturnType<typeof inspectWorkerTerminal>>
type WorkerProviderSession = ReturnType<OrcaRuntimeService['getExactWorkerProviderSession']>

export type ExitedWorkerTerminalReleaseReconciliation =
  | { state: 'not_exited' }
  | { state: 'released'; resource: WorkerTerminalResourceRow }
  | { state: 'release_unknown'; reason: string }

export async function reconcileExitedWorkerTerminalRelease(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  observation: WorkerTerminalObservation
  providerSessionBeforeArchive: WorkerProviderSession
  attachedAtMs: number
}): Promise<ExitedWorkerTerminalReleaseReconciliation> {
  if (args.observation.status !== 'exited') {
    return { state: 'not_exited' }
  }
  const archive = args.db.getWorkerTerminalArchive(args.dispatchId)
  const providerSessionAfterArchive = args.runtime.getExactWorkerProviderSession(
    args.resource.terminal_handle,
    args.attachedAtMs
  )
  const evidenceMatches =
    workerTerminalWorkspaceIsCurrent(args.resource, args.observation) &&
    archive?.resource_id === args.resource.id &&
    exitedWorkerTerminalLeaseIsCurrent(
      args.db,
      args.dispatchId,
      args.resource,
      args.observation.terminal,
      args.observation.exact
    ) &&
    workerProviderSessionIsCurrent(
      args.resource,
      args.providerSessionBeforeArchive,
      providerSessionAfterArchive
    )
  if (!evidenceMatches || !args.resource.process_incarnation) {
    return {
      state: 'release_unknown',
      reason:
        'The exited terminal does not match the recorded workspace, lease, process, provider session, and archive receipt.'
    }
  }
  const liveness = await args.runtime
    .inspectTerminalProcessIncarnationLiveness(
      args.resource.process_incarnation,
      args.resource.host_scope
    )
    .catch(() => 'unverifiable' as const)
  if (liveness !== 'exited') {
    return {
      state: 'release_unknown',
      reason:
        liveness === 'live'
          ? 'The exact worker process is live; worker release remains unknown.'
          : 'The exact worker process is unverifiable on its owning host; worker release remains unknown.'
    }
  }
  if (
    !exitedWorkerTerminalLeaseIsCurrent(
      args.db,
      args.dispatchId,
      args.resource,
      args.observation.terminal,
      args.observation.exact
    )
  ) {
    return {
      state: 'release_unknown',
      reason:
        'The worker lease changed after the exited observation; worker release remains unknown.'
    }
  }
  if (
    !workerProviderSessionIsCurrent(
      args.resource,
      providerSessionAfterArchive,
      args.runtime.getExactWorkerProviderSession(args.resource.terminal_handle, args.attachedAtMs)
    )
  ) {
    return {
      state: 'release_unknown',
      reason:
        'The provider session changed after the exited observation; worker release remains unknown.'
    }
  }
  const terminal = args.observation.terminal
  if (!args.resource.worktree_id || !args.resource.pane_key) {
    return {
      state: 'release_unknown',
      reason: 'The exited terminal does not expose its owning workspace and pane.'
    }
  }
  const retired = await args.runtime.persistExitedWorkerTerminalRetirement({
    worktreeId: args.resource.worktree_id,
    paneKey: args.resource.pane_key,
    ...(terminal?.tabId && terminal.leafId && terminal.ptyId
      ? {
          surface: {
            worktreeId: args.resource.worktree_id,
            parentTabId: terminal.tabId,
            leafId: terminal.leafId,
            ptyId: terminal.ptyId,
            ...(terminal.incarnationId ? { incarnationId: terminal.incarnationId } : {})
          }
        }
      : {})
  })
  if (!retired) {
    return {
      state: 'release_unknown',
      reason: 'The exited terminal surface could not be retired from its owning workspace.'
    }
  }
  const released = args.db.settleWorkerTerminalRelease({
    resourceId: args.resource.id,
    ownerDispatchId: args.dispatchId,
    processIncarnation: args.resource.process_incarnation
  })
  args.runtime.notifyExitedWorkerTerminalRetirement(args.resource.pane_key)
  args.runtime.notifyMessageArrived(`dispatch:${args.dispatchId}`, 'status')
  return { state: 'released', resource: released }
}

export function workerTerminalWorkspaceIsCurrent(
  resource: WorkerTerminalResourceRow,
  observation: WorkerTerminalObservation
): boolean {
  return resource.worktree_id !== null && observation.terminal?.worktreeId === resource.worktree_id
}

function workerProviderSessionIsCurrent(
  resource: WorkerTerminalResourceRow,
  before: WorkerProviderSession,
  after: WorkerProviderSession
): boolean {
  if (!before || !after) {
    return before === after
  }
  return (
    before.processIncarnation === resource.process_incarnation &&
    after.processIncarnation === resource.process_incarnation &&
    before.agent === after.agent &&
    before.providerSession.key === after.providerSession.key &&
    before.providerSession.id === after.providerSession.id &&
    before.providerSession.transcriptPath === after.providerSession.transcriptPath
  )
}
