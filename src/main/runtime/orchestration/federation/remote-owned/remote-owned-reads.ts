import type { OrcaRuntimeService } from '../../../orca-runtime'
import { exposeUtcTimestamp } from '../../db/utc-timestamp'
import {
  countRemoteDispatches,
  listRemoteDispatches,
  type RemoteDispatchRow
} from '../../db/remote-owned/remote-dispatch-records'
import { getRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import type { PeerServerAnswerStatus } from '../peer-mail/peer-mail-relay'

type ReadsRuntime = Pick<
  OrcaRuntimeService,
  'getOrchestrationDb' | 'resolveOrchestrationWorkerServer' | 'getPeerServerAnswerStatus'
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

async function remoteWorkerServer(
  record: RemoteDispatchRow,
  linkState: string | null | undefined,
  name: (environmentId: string) => Promise<string>
): Promise<RemoteWorkerServer> {
  return {
    environmentId: record.environment_id,
    name: await name(record.environment_id),
    asOf: exposeUtcTimestamp(record.updated_at) ?? record.updated_at,
    ...(linkState === 'closed' ? { repaired: true as const } : {})
  }
}

/** The paired server's name; one removed from this Orca since keeps the name a link recorded, else its environment ID. */
export async function remoteServerName(
  runtime: ReadsRuntime,
  environmentId: string,
  recorded?: string | null
): Promise<string> {
  try {
    return (await runtime.resolveOrchestrationWorkerServer(environmentId)).name
  } catch {
    return recorded ?? environmentId
  }
}

/**
 * worker-show for a worker a paired server runs: always this Orca's record, never a call there, so
 * it answers at once whether the server is awake, asleep or off, and agrees with worker-list. The
 * note says when the record is from and what the pull loop last heard from the server. Metadata
 * only: the worker's output stays on its server (worker-read), and a prompt wait arrives as mail.
 */
export async function remoteWorkerShow(runtime: ReadsRuntime, record: RemoteDispatchRow) {
  const link = getRemoteRunLink(runtime.getOrchestrationDb(), record.conversation_id)
  const server = await remoteWorkerServer(
    record,
    link?.state,
    async (id) => await remoteServerName(runtime, id, link?.server_name)
  )
  const heard = server.repaired
    ? undefined
    : runtime.getPeerServerAnswerStatus(record.environment_id)
  const reachable = heard?.unreachableSince ? false : heard?.answeredAt ? true : undefined
  const closedBecause = link?.state === 'closed' ? link.last_error : null
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
      stage: 'server_record',
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
      reason: `${recordNote(server, heard, closedBecause)} Its output is kept only on ${server.name}.${owedStop}`
    },
    server: {
      ...server,
      ...(reachable === undefined ? {} : { reachable }),
      ...(heard?.answeredAt ? { lastAnsweredAt: new Date(heard.answeredAt).toISOString() } : {})
    },
    lastReport: record.last_report,
    autoReleaseAt: null
  }
}

function recordNote(
  server: RemoteWorkerServer,
  heard: PeerServerAnswerStatus | undefined,
  closedBecause: string | null
): string {
  if (server.repaired) {
    // Why the link closed (a re-made pairing, or the server removed), as recorded when it closed.
    const why = closedBecause ?? `The pairing with ${server.name} was re-made.`
    return `${why} It no longer reports this worker here; this is ${server.name}'s state as of ${server.asOf}.`
  }
  const state = `${server.name}'s state as of ${server.asOf}.`
  const ago = heard?.answeredAt
    ? `${Math.max(0, Math.round((Date.now() - heard.answeredAt) / 1000))} s ago`
    : undefined
  if (heard?.unreachableSince) {
    return `${state} ${server.name} could not be reached${ago ? `; it last answered ${ago}` : ''}.`
  }
  return ago ? `${state} ${server.name} last answered ${ago}.` : state
}

export type RemoteWorkerListRow = Awaited<ReturnType<typeof remoteWorkerListRow>>

async function remoteWorkerListRow(
  record: ReturnType<typeof listRemoteDispatches>[number],
  name: (environmentId: string, recorded: string | null) => Promise<string>
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
    server: await remoteWorkerServer(
      record,
      record.link_state,
      async (id) => await name(id, record.server_name)
    )
  }
}

type WorkerListPage = {
  workers: readonly unknown[]
  page: { total: number }
  warnings?: string[]
}

/**
 * Workers paired servers run for the listed Runs join the first page after this Orca's own, newest
 * first, at most `maxRows` of them and as each server last reported them; no server is asked. So
 * the first page can hold up to twice its limit, and nothing is pushed past it. Every page's `total` counts
 * them. Later pages follow this Orca's own cursor, and a terminal-state filter leaves them out,
 * since only their server knows their terminals.
 */
export async function withRemoteWorkerRows<Page extends WorkerListPage>(
  runtime: ReadsRuntime,
  params: { run?: string; cursor?: string; terminalState?: string },
  page: Page,
  maxRows: number
): Promise<Page> {
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
  const name = async (id: string, recorded: string | null): Promise<string> => {
    const key = `${id}\n${recorded ?? ''}`
    const known = names.get(key) ?? (await remoteServerName(runtime, id, recorded))
    names.set(key, known)
    return known
  }
  const rows = await Promise.all(
    listRemoteDispatches(db, { runId: params.run, limit: Math.max(0, maxRows) }).map(
      async (record) => await remoteWorkerListRow(record, name)
    )
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
