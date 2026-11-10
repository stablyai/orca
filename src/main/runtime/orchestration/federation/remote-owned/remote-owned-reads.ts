import type { OrcaRuntimeService } from '../../../orca-runtime'
import { exposeUtcTimestamp } from '../../db/utc-timestamp'
import {
  listRemoteDispatches,
  type RemoteDispatchRow
} from '../../db/remote-owned/remote-dispatch-records'

type ReadsRuntime = Pick<
  OrcaRuntimeService,
  'getOrchestrationDb' | 'resolveOrchestrationWorkerServer'
>

/** A remote worker's server as this Orca names it, and when that server last told it about the worker. */
export type RemoteWorkerServer = { environmentId: string; name: string; lastSeenAt: string }

function remoteWorkerServer(
  record: RemoteDispatchRow,
  name: (environmentId: string) => string
): RemoteWorkerServer {
  return {
    environmentId: record.environment_id,
    name: name(record.environment_id),
    lastSeenAt: exposeUtcTimestamp(record.updated_at) ?? record.updated_at
  }
}

/** The paired server's name; one removed from this Orca since keeps its environment ID. */
export function remoteServerName(runtime: ReadsRuntime, environmentId: string): string {
  try {
    return runtime.resolveOrchestrationWorkerServer(environmentId).name
  } catch {
    return environmentId
  }
}

/**
 * worker-show for a remote worker whose server could not be reached: this Orca's record in the
 * ordinary show shape, labelled with the server and when it last heard. Metadata only; the
 * worker's output stays on its server.
 */
export function offlineRemoteWorkerShow(runtime: ReadsRuntime, record: RemoteDispatchRow) {
  const server = remoteWorkerServer(record, (id) => remoteServerName(runtime, id))
  const owedStop = record.stop_owed
    ? ` A stop is owed; this Orca sends it when ${server.name} answers.`
    : ''
  return {
    dispatch: {
      id: record.dispatch_id,
      runId: record.run_id,
      taskId: record.task_id,
      task_id: record.task_id,
      status: record.status,
      lastFailure: record.last_failure,
      followUpOf: null
    },
    worker: {
      dispatchId: record.dispatch_id,
      state: record.worker_state ?? record.status,
      stage: 'server_unreachable',
      agentTerminalHandle: null,
      worktreeId: null,
      lastError: record.last_failure,
      updatedAt: server.lastSeenAt
    },
    projection: null,
    terminal: null,
    terminalResource: null,
    observation: {
      status: 'unverifiable' as const,
      exactWorker: false,
      reason: `${server.name} could not be reached, so this is this Orca's record of the worker as ${server.name} last reported it at ${server.lastSeenAt}. Its output is kept only on ${server.name}.${owedStop}`
    },
    server: { ...server, reachable: false as const },
    lastReport: record.last_report,
    autoReleaseAt: null
  }
}

export type RemoteWorkerListRow = ReturnType<typeof remoteWorkerListRow>

function remoteWorkerListRow(record: RemoteDispatchRow, name: (environmentId: string) => string) {
  return {
    dispatchId: record.dispatch_id,
    taskId: record.task_id,
    runId: record.run_id,
    workerState: record.worker_state ?? record.status,
    dispatchStatus: record.status,
    agentTerminalHandle: null,
    terminalState: null,
    resource: null,
    server: remoteWorkerServer(record, name)
  }
}

/**
 * The workers paired servers run for the listed Runs, as each server last reported them; no server
 * is asked. Newest first, at most `limit`, and `more` when the records hold others.
 */
function remoteWorkerListRows(
  runtime: ReadsRuntime,
  scope: { runId?: string; limit: number }
): { rows: RemoteWorkerListRow[]; more: boolean } {
  const records = listRemoteDispatches(runtime.getOrchestrationDb(), {
    runId: scope.runId,
    limit: scope.limit + 1
  })
  const names = new Map<string, string>()
  const name = (id: string): string => {
    const known = names.get(id) ?? remoteServerName(runtime, id)
    names.set(id, known)
    return known
  }
  return {
    rows: records.slice(0, scope.limit).map((record) => remoteWorkerListRow(record, name)),
    more: records.length > scope.limit
  }
}

/**
 * Workers paired servers run for this Orca's Runs join the first page, as each server last reported
 * them. Later pages follow this Orca's own cursor, and a terminal-state filter leaves them out, since
 * only their server knows their terminals.
 */
export function withRemoteWorkerRows<Page extends WorkerListPage>(
  runtime: ReadsRuntime,
  params: { run?: string; cursor?: string; terminalState?: string },
  page: Page,
  maxRows: number
): Page {
  if (params.cursor || params.terminalState) {
    return page
  }
  const remote = remoteWorkerListRows(runtime, {
    runId: params.run,
    limit: maxRows
  })
  if (remote.rows.length === 0) {
    return page
  }
  const warnings = remote.more
    ? [
        ...(page.warnings ?? []),
        `Showing the newest ${remote.rows.length} workers on paired servers; scope the list with --run to see the others.`
      ]
    : page.warnings
  return {
    ...page,
    workers: [...page.workers, ...remote.rows],
    page: { ...page.page, total: page.page.total + remote.rows.length },
    ...(warnings ? { warnings } : {})
  }
}

type WorkerListPage = {
  workers: readonly unknown[]
  page: { total: number }
  warnings?: string[]
}
