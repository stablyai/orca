import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import type {
  ClaudeProfileSetupJob,
  ClaudeProfileWorkerRequest,
  ClaudeProfileWorkerResponse
} from './claude-profile-worker-contract'

export class ClaudeProfileSetupWorker {
  private readonly queue: WorkerThreadRequestQueue<
    ClaudeProfileWorkerRequest,
    ClaudeProfileWorkerResponse
  >
  constructor(
    factory: WorkerThreadFactory = () => {
      const entry = resolveWorkerThreadEntryPath(
        currentWorkerEntryLayout(__dirname),
        'claude-profile-worker-entry.js'
      )
      const path = [entry, join(dirname(entry), '..', 'claude-profile-worker-entry.js')].find(
        existsSync
      )
      if (!path) {
        throw new Error('Claude profile worker entry is unavailable')
      }
      return new Worker(path)
    }
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory,
      idleTeardownMs: 1000,
      maxConsecutiveDeaths: 1,
      queueCap: { maxQueuedCalls: 16, describeFull: () => 'Claude profile setup queue is full' },
      createUnavailableError: (message) => new Error(message),
      describeTimeout: () => 'Claude profile setup timed out',
      describeExit: (code) => `Claude profile worker exited (${code})`,
      describeCrashLoop: (message) => `Claude profile worker failed: ${message}`,
      onUnavailable: () => {}
    })
  }
  async prepare(job: ClaudeProfileSetupJob, signal?: AbortSignal) {
    const response = await this.queue.dispatch((id) => ({ id, job }), 120_000, signal)
    if (!response.ok) {
      throw new Error(response.message)
    }
    return response.report
  }
  dispose(): void {
    this.queue.dispose()
  }
}
