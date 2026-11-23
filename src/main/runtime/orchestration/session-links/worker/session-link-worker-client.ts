// The event loop's way to session links: one worker per orchestration database, started on first
// use and released when idle. A crash fails the calls it caught; the next call starts a new worker.
import { spawnWorkerThread } from '../../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../../worker-threads/worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../../../../worker-threads/worker-thread-request-queue'
import type { WorkerThreadFactory } from '../../../../worker-threads/worker-thread-transport'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  crewMessageInvalidation,
  type CrewMessageFacts
} from '../../crew/crew-mutation-notifications'
import { OrchestrationError } from '../../orchestration-error'
import {
  SESSION_LINK_OPS,
  type SessionLinkOp,
  type SessionLinks,
  type SessionLinkWorkerRequest,
  type SessionLinkWorkerResponse
} from './session-link-worker-protocol'

const WORKER_ENTRY_FILENAME = 'session-link-worker-entry.js'
// One call's budget from dispatch: a cold open plus a lock wait behind the runtime's own writes.
const OPERATION_TIMEOUT_MS = 10_000
const IDLE_TEARDOWN_MS = 60_000
const MAX_QUEUED_CALLS = 500

function spawnSessionLinkWorker(): ReturnType<WorkerThreadFactory> {
  return spawnWorkerThread(
    resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_ENTRY_FILENAME),
    { name: 'orca-session-links' }
  )
}

function unavailable(message: string): OrchestrationError {
  return new OrchestrationError(
    'session_link_unavailable',
    `Session links didn't answer (${message}). A change may still have landed: repeat it with the same operation.`
  )
}

class SessionLinkWorkerClient {
  private readonly queue: WorkerThreadRequestQueue<
    SessionLinkWorkerRequest,
    SessionLinkWorkerResponse
  >

  constructor(
    private readonly path: string,
    factory: WorkerThreadFactory,
    private readonly onMail: (mail: CrewMessageFacts[]) => void
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: 2,
      queueCap: {
        maxQueuedCalls: MAX_QUEUED_CALLS,
        describeFull: (request) => `too many waiting calls, ${request.op} refused`
      },
      // A timed-out transaction can still be inside SQLite; never start a second worker beside it.
      awaitRetirement: true,
      createUnavailableError: unavailable,
      describeTimeout: (ms) => `the session link worker timed out after ${ms}ms`,
      describeExit: (code) => `the session link worker exited with code ${code}`,
      describeCrashLoop: (lastError) => `the session link worker crashed repeatedly: ${lastError}`,
      onUnavailable: (error) => console.warn('[session-link] worker unavailable:', error)
    })
  }

  /** A refusal from the store comes back as an Error with the store's own message. */
  async call(op: SessionLinkOp, args: unknown[]): Promise<unknown> {
    let response: SessionLinkWorkerResponse
    try {
      response = await this.queue.dispatch(
        (id) => ({ id, path: this.path, op, args }),
        OPERATION_TIMEOUT_MS
      )
    } catch (error) {
      throw error instanceof OrchestrationError
        ? error
        : unavailable(error instanceof Error ? error.message : String(error))
    }
    if (response.ok) {
      this.onMail(response.mail)
      return response.value
    }
    throw new Error(response.error)
  }

  remote(): SessionLinks {
    const remote = Object.fromEntries(
      SESSION_LINK_OPS.map((op) => [op, (...args: unknown[]) => this.call(op, args)])
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each op forwards its own arguments to the SessionLinkOperations method of that name, whose return value the worker answers unchanged.
    return remote as unknown as SessionLinks
  }

  dispose(): void {
    this.queue.dispose()
  }
}

const NO_FILE = 'Session links need the orchestration database file.'
const refuse = (message: string) => (): Promise<never> => Promise.reject(new Error(message))

/** An in-memory database has no file for a worker to join, so it holds no links; tests bind one. */
const NO_SESSION_LINKS: SessionLinks = {
  get: refuse('Session link not found.'),
  forSession: () => Promise.resolve(null),
  list: () => Promise.resolve([]),
  pending: () => Promise.resolve([]),
  events: () => Promise.resolve([]),
  event: () => Promise.resolve(null),
  write: refuse(NO_FILE),
  pause: refuse(NO_FILE),
  reserve: refuse(NO_FILE),
  create: refuse(NO_FILE),
  send: refuse(NO_FILE),
  control: refuse(NO_FILE),
  setPolicy: refuse(NO_FILE),
  addParticipants: refuse(NO_FILE),
  resolve: refuse(NO_FILE)
}

const clients = new WeakMap<
  OrchestrationDb,
  { client: SessionLinkWorkerClient; links: SessionLinks }
>()

function bind(db: OrchestrationDb, factory: WorkerThreadFactory): SessionLinks {
  clients.get(db)?.client.dispose()
  // The worker's mail skips the runtime's insert, so Crew hears of it here, as it would there.
  const client = new SessionLinkWorkerClient(db.path, factory, (mail) => {
    for (const message of mail) {
      const notice = crewMessageInvalidation(message)
      if (notice) {
        db.crewChanges.notify(notice)
      }
    }
  })
  const links = client.remote()
  clients.set(db, { client, links })
  return links
}

/** This orchestration database's session links, every call answered by its worker. */
export function sessionLinks(db: OrchestrationDb): SessionLinks {
  return (
    clients.get(db)?.links ??
    (db.path === ':memory:' ? NO_SESSION_LINKS : bind(db, spawnSessionLinkWorker))
  )
}

/** Answers `db`'s session links through `factory`: tests run the worker's handler in process. */
export function bindSessionLinkWorker(
  db: OrchestrationDb,
  factory: WorkerThreadFactory
): SessionLinks {
  return bind(db, factory)
}
