import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../worker-threads/worker-thread-request-queue'
import {
  surfaceExecutorIntentSchema,
  type SurfaceExecutorAdmission,
  type SurfaceExecutorIntent
} from '../../shared/workspace-surfaces/surface-executor-contract'

/** A finite read on the owning host; no SQLite or filesystem fallback may block the event loop. */
export class SurfaceExecutorReader {
  private readonly queue: WorkerThreadRequestQueue<
    { id: number; admission: SurfaceExecutorAdmission },
    { id: number; intent: unknown }
  >

  constructor(
    workerPath = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'surface-executor-reader-entry.js'
    )
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory: () => spawnWorkerThread(workerPath, { execArgv: [] }),
      idleTeardownMs: 30_000,
      maxConsecutiveDeaths: 2,
      awaitRetirement: true,
      createUnavailableError: (message) => new Error(message),
      describeTimeout: () => 'Surface execution read did not answer',
      describeExit: (code) => `Surface execution reader exited (${code})`,
      describeCrashLoop: (message) => message,
      onUnavailable: () => {}
    })
  }

  async read(admission: SurfaceExecutorAdmission): Promise<SurfaceExecutorIntent> {
    try {
      const response = await this.queue.dispatch((id) => ({ id, admission }), 15_000)
      const parsed = surfaceExecutorIntentSchema.safeParse(response.intent)
      return parsed.success ? parsed.data : { kind: 'unreadable' }
    } catch {
      return { kind: 'unreadable' }
    }
  }

  dispose(): void {
    this.queue.dispose()
  }
}
