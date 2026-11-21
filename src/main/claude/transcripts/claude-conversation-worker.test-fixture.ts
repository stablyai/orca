import type * as WorkerThreads from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import { vi } from 'vitest'

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerThreads>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        super(filename, {
          ...options,
          execArgv: [
            ...(options?.execArgv ?? []),
            '--import',
            new URL('./claude-conversation-worker.test-loader.mjs', import.meta.url).href
          ]
        })
      }
    }
  }
})
