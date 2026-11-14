import type * as WorkerClient from './foreign-sqlite-reader-client'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterAll, vi } from 'vitest'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'

vi.mock('./foreign-sqlite-reader-client', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerClient>()
  const loader = createRequire(import.meta.url).resolve('tsx/cjs')
  const entry = resolve('src/main/foreign-sqlite-readers/foreign-sqlite-reader-entry.ts')
  const clients = new Set<WorkerClient.ForeignSqliteReaderClient>()
  afterAll(() => {
    for (const client of clients) {
      client.dispose()
    }
  })
  return {
    ...actual,
    ForeignSqliteReaderClient: class extends actual.ForeignSqliteReaderClient {
      constructor(options: ConstructorParameters<typeof actual.ForeignSqliteReaderClient>[0]) {
        super({
          ...options,
          workerFactory: () =>
            spawnWorkerThread(
              `require(${JSON.stringify(loader)}); require(${JSON.stringify(entry)})`,
              { eval: true, execArgv: ['--conditions=orca-source'] }
            )
        })
        clients.add(this)
      }
    }
  }
})
