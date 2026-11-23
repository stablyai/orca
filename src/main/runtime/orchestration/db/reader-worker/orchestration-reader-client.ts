// Read-only orchestration queries on their own thread: a contended or slow database waits there, not on
// the runtime's loop. Started on first use, released when idle. A database with no file (tests) reads
// in place; a failed, timed-out or crashed read fails its caller and never moves onto the runtime's thread.
import { spawnWorkerThread } from '../../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../../worker-threads/worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../../../../worker-threads/worker-thread-request-queue'
import type {
  WorkerRequestTransport,
  WorkerThreadFactory
} from '../../../../worker-threads/worker-thread-transport'
import { readConnectorWorkerCandidates } from '../connector-workers/connector-worker-candidates'
import type { OrchestrationDbConnection } from '../orchestration-db'
import type {
  OrchestrationReadName,
  OrchestrationReaderRequest,
  OrchestrationReaderResponse,
  OrchestrationReads
} from './orchestration-reader-protocol'

const WORKER_ENTRY_FILENAME = 'orchestration-reader-entry.js'
// A read's budget from dispatch: a cold open plus main's own 5 s lock wait.
const READ_TIMEOUT_MS = 10_000
// Outlives the connector's 10 s poll, so a polling runtime keeps one warm thread.
const IDLE_TEARDOWN_MS = 60_000
const MAX_QUEUED_READS = 100

function spawnOrchestrationReader(): WorkerRequestTransport {
  return spawnWorkerThread(
    resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_ENTRY_FILENAME),
    { name: 'orca-orchestration-reader' }
  )
}

const IN_PLACE: {
  [K in OrchestrationReadName]: (
    connection: OrchestrationDbConnection,
    args: OrchestrationReads[K]['args']
  ) => OrchestrationReads[K]['value']
} = {
  connectorWorkerCandidates: (connection, args) =>
    readConnectorWorkerCandidates(connection, args.sessionIds, args.now)
}

/** The file a connection reads; empty for an in-memory database. */
export function orchestrationDbFile(connection: OrchestrationDbConnection): string {
  const main = connection.db
    .prepare('PRAGMA database_list')
    .all()
    .find((row) => row.name === 'main')
  return typeof main?.file === 'string' ? main.file : ''
}

export class OrchestrationReaderClient {
  private readonly queue: WorkerThreadRequestQueue<
    OrchestrationReaderRequest,
    OrchestrationReaderResponse
  >
  private readonly files = new WeakMap<OrchestrationDbConnection, string>()

  constructor(
    factory: WorkerThreadFactory = spawnOrchestrationReader,
    private readonly timeoutMs = READ_TIMEOUT_MS
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: 2,
      queueCap: {
        maxQueuedCalls: MAX_QUEUED_READS,
        describeFull: (request) => `too many waiting reads, ${request.read} refused`
      },
      // A timed-out read can still be inside SQLite; never start a second thread beside it.
      awaitRetirement: true,
      createUnavailableError: (message) => new Error(`orchestration read failed: ${message}`),
      describeTimeout: (ms) => `the orchestration reader timed out after ${ms}ms`,
      describeExit: (code) => `the orchestration reader exited with code ${code}`,
      describeCrashLoop: (lastError) => `the orchestration reader crashed repeatedly: ${lastError}`,
      onUnavailable: (error) => console.error('[orchestration] reader thread unavailable:', error)
    })
  }

  /** `connection` is main's own, which has created and migrated the file the thread opens. */
  async read<K extends OrchestrationReadName>(
    connection: OrchestrationDbConnection,
    read: K,
    args: OrchestrationReads[K]['args']
  ): Promise<OrchestrationReads[K]['value']> {
    let path = this.files.get(connection)
    if (path === undefined) {
      path = orchestrationDbFile(connection)
      this.files.set(connection, path)
    }
    if (!path) {
      return IN_PLACE[read](connection, args)
    }
    const response = await this.queue.dispatch(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `read` and `args` share K, which the union cannot correlate.
      (id) => ({ id, path, read, args }) as OrchestrationReaderRequest,
      this.timeoutMs
    )
    if (!response.ok) {
      throw new Error(response.error)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the thread answers `read` with its own value type.
    return response.value as OrchestrationReads[K]['value']
  }

  dispose(): void {
    this.queue.dispose()
  }
}

let shared: OrchestrationReaderClient | null = null

/** The process's one orchestration reader. */
export function orchestrationReader(): OrchestrationReaderClient {
  shared ??= new OrchestrationReaderClient()
  return shared
}
