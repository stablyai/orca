import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

// Finds an owned, settled, exact-match resource for an explicitly reused terminal.
export function findTransferableWorkerTerminalResource(
  this: OrchestrationDb,
  params: {
    terminalHandle: string
    paneKey: string | null
    processIncarnation: string | null
    hostScope: string | null
  }
): WorkerTerminalResourceRow | undefined {
  if (!params.paneKey || !params.processIncarnation) {
    return undefined
  }
  const candidates = this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ?
          AND ownership_state != 'released'`
    )
    .all(params.processIncarnation, params.hostScope) as WorkerTerminalResourceRow[]
  const exact = candidates.filter(
    (candidate) =>
      candidate.pane_key &&
      params.paneKey &&
      isEquivalentPaneKey(candidate.pane_key, params.paneKey) &&
      candidate.process_incarnation === params.processIncarnation &&
      candidate.host_scope === params.hostScope
  )
  if (
    exact.some((candidate) =>
      ['requested', 'releasing', 'unknown'].includes(candidate.release_state)
    )
  ) {
    throw new OrchestrationError(
      'terminal_release_in_progress',
      `Terminal ${params.terminalHandle} has a release in progress; wait for cleanup or use another terminal.`
    )
  }
  return exact.find(
    (candidate) =>
      candidate.ownership_state === 'owned' &&
      ['not_requested', 'retained'].includes(candidate.release_state) &&
      ['succeeded', 'failed', 'stopped', 'abandoned'].includes(
        this.getWorkerDispatch(candidate.owner_dispatch_id)?.state ??
          this.getRemoteDispatchAttachment(candidate.owner_dispatch_id)?.state ??
          ''
      )
  )
}

export function workerTerminalResourceHasIdentityConflict(
  this: OrchestrationDb,
  resourceId: string
): boolean {
  const resource = this.getWorkerTerminalResource(resourceId)
  if (!resource?.pane_key || !resource.process_incarnation) {
    return true
  }
  const candidates = this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ?
          AND id != ? AND ownership_state != 'released'`
    )
    .all(
      resource.process_incarnation,
      resource.host_scope,
      resource.id
    ) as WorkerTerminalResourceRow[]
  return candidates.some(
    (candidate) =>
      candidate.pane_key &&
      isEquivalentPaneKey(candidate.pane_key, resource.pane_key as string) &&
      candidate.process_incarnation === resource.process_incarnation &&
      candidate.host_scope === resource.host_scope
  )
}

/** Whether a dispatch that has not settled still owns the terminal of this process, read through
 *  the resource row so a transferred terminal answers for its current owner. */
export function hasOpenWorkerDispatchForProcess(
  this: OrchestrationDb,
  params: { processIncarnation: string; hostScope: string }
): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly this one column.
  const owners = this.db
    .prepare(
      `SELECT owner_dispatch_id FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ? AND ownership_state = 'owned'`
    )
    .all(params.processIncarnation, params.hostScope) as { owner_dispatch_id: string }[]
  return owners.some((row) =>
    ['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'].includes(
      this.getWorkerDispatch(row.owner_dispatch_id)?.state ?? ''
    )
  )
}

/** Every resource whose process incarnation starts with `prefix`, newest first. */
export function listWorkerTerminalResourcesByIncarnationPrefix(
  this: OrchestrationDb,
  prefix: string
): WorkerTerminalResourceRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE substr(process_incarnation, 1, ?) = ? ORDER BY updated_at DESC`
    )
    .all(prefix.length, prefix) as WorkerTerminalResourceRow[]
}

export type WorkerTerminalTransferMethods = {
  findTransferableWorkerTerminalResource: typeof findTransferableWorkerTerminalResource
  workerTerminalResourceHasIdentityConflict: typeof workerTerminalResourceHasIdentityConflict
  hasOpenWorkerDispatchForProcess: typeof hasOpenWorkerDispatchForProcess
  listWorkerTerminalResourcesByIncarnationPrefix: typeof listWorkerTerminalResourcesByIncarnationPrefix
}

export function attachWorkerTerminalTransfer(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    findTransferableWorkerTerminalResource,
    workerTerminalResourceHasIdentityConflict,
    hasOpenWorkerDispatchForProcess,
    listWorkerTerminalResourcesByIncarnationPrefix
  })
}
