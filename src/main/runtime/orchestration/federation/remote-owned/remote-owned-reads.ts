import type { OrcaRuntimeService } from '../../../orca-runtime'
import { exposeUtcTimestamp } from '../../db/utc-timestamp'
import {
  countRemoteDispatches,
  listRemoteDispatches,
  type RemoteDispatchRow
} from '../../db/remote-owned/remote-dispatch-records'
import { getRemoteRunLink } from '../../db/remote-owned/remote-run-links'

type ReadsRuntime = Pick<
  OrcaRuntimeService,
  'getOrchestrationDb' | 'resolveOrchestrationWorkerServer'
>

/**
 * A remote worker's server as this Orca names it. `asOf` is when this Orca recorded the server's
 * latest state for the worker; `repaired` means the pairing was re-made since, so the server no
 * longer reports this worker here.
 */
export type RemoteWorkerServer = {
  environmentId: string
  name: string
  asOf: string
  repaired?: true
}

function remoteWorkerServer(
  record: RemoteDispatchRow,
  linkState: string | null | undefined,
  name: (environmentId: string) => string
): RemoteWorkerServer {
  return {
    environmentId: record.environment_id,
    name: name(record.environment_id),
    asOf: exposeUtcTimestamp(record.updated_at) ?? record.updated_at,
    ...(linkState === 'closed' ? { repaired: true as const } : {})
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
 * ordinary show shape, labelled with the server and the time of its last report. Metadata only;
 * the worker's output stays on its server.
 */
export function offlineRemoteWorkerShow(runtime: ReadsRuntime, record: RemoteDispatchRow) {
  const link = getRemoteRunLink(runtime.getOrchestrationDb(), record.conversation_id)
  const server = remoteWorkerServer(record, link?.state, (id) => remoteServerName(runtime, id))
  const why = server.repaired
    ? `The pairing with ${server.name} was re-made, so it no longer reports this worker here`
    : `${server.name} could not be reached`
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
      updatedAt: server.asOf
    },
    projection: null,
    terminal: null,
    terminalResource: null,
    observation: {
      status: 'unverifiable' as const,
      exactWorker: false,
      reason: `${why}, so this is this Orca's record of the worker: its state as of ${server.asOf}. Its output is kept only on ${server.name}.${owedStop}`
    },
    server: { ...server, reachable: false as const },
    lastReport: record.last_report,
    autoReleaseAt: null
  }
}

export type RemoteWorkerListRow = ReturnType<typeof remoteWorkerListRow>

function remoteWorkerListRow(
  record: ReturnType<typeof listRemoteDispatches>[number],
  name: (environmentId: string) => string
) {
  return {
    dispatchId: record.dispatch_id,
    taskId: record.task_id,
    runId: record.run_id,
    workerState: record.worker_state ?? record.status,
    dispatchStatus: record.status,
    agentTerminalHandle: null,
    terminalState: null,
    resource: null,
    server: remoteWorkerServer(record, record.link_state, name)
  }
}

type WorkerListPage = {
  workers: readonly unknown[]
  page: { total: number }
  warnings?: string[]
}

/**
 * Workers paired servers run for the listed Runs join the first page after this Orca's own, newest
 * first and as each server last reported them; no server is asked. Every page's `total` counts
 * them. Later pages follow this Orca's own cursor, and a terminal-state filter leaves them out,
 * since only their server knows their terminals.
 */
export function withRemoteWorkerRows<Page extends WorkerListPage>(
  runtime: ReadsRuntime,
  params: { run?: string; cursor?: string; terminalState?: string },
  page: Page,
  maxRows: number
): Page {
  if (params.terminalState) {
    return page
  }
  const db = runtime.getOrchestrationDb()
  const total = countRemoteDispatches(db, params.run)
  if (total === 0) {
    return page
  }
  if (params.cursor) {
    return { ...page, page: { ...page.page, total: page.page.total + total } }
  }
  const names = new Map<string, string>()
  const name = (id: string): string => {
    const known = names.get(id) ?? remoteServerName(runtime, id)
    names.set(id, known)
    return known
  }
  const rows = listRemoteDispatches(db, { runId: params.run, limit: Math.max(0, maxRows) }).map(
    (record) => remoteWorkerListRow(record, name)
  )
  const warnings =
    rows.length < total
      ? [
          ...(page.warnings ?? []),
          `Showing the newest ${rows.length} of ${total} workers on paired servers.`
        ]
      : page.warnings
  return {
    ...page,
    workers: [...page.workers, ...rows],
    page: { ...page.page, total: page.page.total + total },
    ...(warnings ? { warnings } : {})
  }
}
