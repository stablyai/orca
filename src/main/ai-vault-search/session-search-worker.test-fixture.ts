import type * as WorkerClient from './session-search-worker-client'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'

vi.mock('./session-search-worker-client', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerClient>()
  const require = createRequire(import.meta.url)
  const loader = require.resolve('tsx/cjs')
  const entry = resolve('src/main/ai-vault-search/session-search-worker-entry.ts')
  return {
    ...actual,
    SessionSearchWorkerClient: class extends actual.SessionSearchWorkerClient {
      constructor(onChange?: ConstructorParameters<typeof actual.SessionSearchWorkerClient>[0]) {
        super(onChange, () =>
          spawnWorkerThread(
            `require(${JSON.stringify(loader)}); require(${JSON.stringify(entry)})`,
            {
              eval: true,
              execArgv: ['--conditions=orca-source']
            }
          )
        )
      }
    }
  }
})
