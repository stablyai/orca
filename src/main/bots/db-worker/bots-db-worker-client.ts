// The runtime's one bots DB worker: started on first use, released when idle. A crash fails the calls
// it caught with items_unavailable; the next call starts a new worker. Bot stores reach their SQL only through it.
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../../worker-threads/worker-thread-request-queue'
import type {
  WorkerRequestTransport,
  WorkerThreadFactory
} from '../../worker-threads/worker-thread-transport'
import { BOT_ITEM_ERROR_CODES, type BotItemErrorCode } from '../../../shared/bots/bot-items'
import { BotItemError } from '../bot-item-error'
import { BOT_ITEMS_OPS, type BotItemsCallWrap, type BotItemsRemote } from '../bot-items-ops'
import type {
  BotsDbStoreName,
  BotsDbWorkerRequest,
  BotsDbWorkerResponse
} from './bots-db-worker-protocol'

const WORKER_ENTRY_FILENAME = 'bots-db-worker-entry.js'
// One call's budget from dispatch: a cold open (migration, WAL) plus a lock wait.
const OPERATION_TIMEOUT_MS = 10_000
const IDLE_TEARDOWN_MS = 60_000
const MAX_QUEUED_CALLS = 500

function spawnBotsDbWorker(): WorkerRequestTransport {
  return spawnWorkerThread(
    resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_ENTRY_FILENAME),
    { name: 'orca-bots-db' }
  )
}

function unavailable(message: string): BotItemError {
  return new BotItemError(
    'items_unavailable',
    `Items didn't answer (${message}). A write may still have landed: repeat it with the same --retry-request.`
  )
}

function isItemErrorCode(code: string | undefined): code is BotItemErrorCode {
  return code === 'invalid_argument' || BOT_ITEM_ERROR_CODES.some((entry) => entry === code)
}

export class BotsDbWorkerClient {
  private readonly queue: WorkerThreadRequestQueue<BotsDbWorkerRequest, BotsDbWorkerResponse>

  constructor(
    factory: WorkerThreadFactory = spawnBotsDbWorker,
    private readonly timeoutMs = OPERATION_TIMEOUT_MS
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: 2,
      queueCap: {
        maxQueuedCalls: MAX_QUEUED_CALLS,
        describeFull: (request) => `too many waiting calls, ${request.store}.${request.op} refused`
      },
      // A timed-out transaction can still be inside SQLite; never start a second worker beside it.
      awaitRetirement: true,
      createUnavailableError: (message) => unavailable(message),
      describeTimeout: (ms) => `the bots DB worker timed out after ${ms}ms`,
      describeExit: (code) => `the bots DB worker exited with code ${code}`,
      describeCrashLoop: (lastError) => `the bots DB worker crashed repeatedly: ${lastError}`,
      onUnavailable: (error) => console.warn('[bots] bots DB worker unavailable:', error)
    })
  }

  /** One store call in the worker; a store's refusal comes back as the same error. */
  async call(store: BotsDbStoreName, path: string, op: string, args: unknown[]): Promise<unknown> {
    let response: BotsDbWorkerResponse
    try {
      response = await this.queue.dispatch((id) => ({ id, store, path, op, args }), this.timeoutMs)
    } catch (error) {
      throw error instanceof BotItemError
        ? error
        : unavailable(error instanceof Error ? error.message : String(error))
    }
    if (response.ok) {
      return response.value
    }
    if (store === 'items' && isItemErrorCode(response.code)) {
      throw new BotItemError(response.code, response.error, response.data)
    }
    throw new Error(response.error)
  }

  /** The items store in `path`, every call answered by the worker. */
  items(path: string, around: BotItemsCallWrap = (_op, run) => run()): BotItemsRemote {
    const remote = Object.fromEntries(
      BOT_ITEMS_OPS.map((op) => [
        op,
        (...args: unknown[]) => around(op, () => this.call('items', path, op, args))
      ])
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each op forwards its own arguments to the store method of that name, whose return value the worker answers unchanged.
    return remote as unknown as BotItemsRemote
  }

  dispose(): void {
    this.queue.dispose()
  }
}
