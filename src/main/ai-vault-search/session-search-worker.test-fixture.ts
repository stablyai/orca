import type { SearchWorkerResponse } from './session-search-worker-protocol'
// @orca-isolated-worker -- Its worker factory mock must be installed in each importing module graph.
import type * as WorkerClient from './session-search-worker-client'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'

const control = vi.hoisted(() => {
  const state: {
    prelude: string
    data: unknown
    onResponse: ((response: SearchWorkerResponse) => void) | undefined
  } = { prelude: '', data: undefined, onResponse: undefined }
  return state
})

export function configureSessionSearchWorkerFixture(options?: {
  prelude: string
  data: unknown
  onResponse: (response: SearchWorkerResponse) => void
}): void {
  control.prelude = options?.prelude ?? ''
  control.data = options?.data
  control.onResponse = options?.onResponse
}

vi.mock('./session-search-worker-client', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerClient>()
  const require = createRequire(import.meta.url)
  const loader = require.resolve('tsx/cjs')
  const entry = resolve('src/main/ai-vault-search/session-search-worker-entry.ts')
  return {
    ...actual,
    SessionSearchWorkerClient: class extends actual.SessionSearchWorkerClient {
      constructor(onChange?: ConstructorParameters<typeof actual.SessionSearchWorkerClient>[0]) {
        super(
          (response) => {
            control.onResponse?.(response)
            onChange?.(response)
          },
          () =>
            spawnWorkerThread(
              `require(${JSON.stringify(loader)}); ${control.prelude}; require(${JSON.stringify(entry)})`,
              {
                eval: true,
                workerData: control.data,
                execArgv: ['--conditions=orca-source']
              }
            )
        )
      }
    }
  }
})
