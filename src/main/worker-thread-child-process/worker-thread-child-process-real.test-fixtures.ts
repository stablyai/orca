import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import * as workerProcesses from './worker-thread-child-process'
import {
  createWorkerThreadChildProcessTestEntry,
  createWorkerThreadChildProcessTestHost
} from './worker-thread-child-process-worker.test-fixtures'

/** Provide the built worker entry missing from source-level real-Git tests. */
export function installRealWorkerThreadChildProcesses(): void {
  let dispose: (() => Promise<void>) | undefined
  let host: ReturnType<typeof createWorkerThreadChildProcessTestHost> | undefined
  let restoreSpawn: (() => void) | undefined
  beforeAll(async () => {
    const entry = await createWorkerThreadChildProcessTestEntry()
    host = createWorkerThreadChildProcessTestHost(entry.entryPath)
    host.releaseOutput()
    const currentHost = host
    dispose = async () => {
      await currentHost.dispose()
      await entry.dispose()
    }
  })
  beforeEach(() => {
    const currentHost = host
    if (!currentHost) {
      throw new Error('Test process worker not initialized')
    }
    const spawn = vi
      .spyOn(workerProcesses, 'spawnProcessOnWorkerThread')
      .mockImplementation((spec) => currentHost.spawn(spec))
    restoreSpawn = () => spawn.mockRestore()
  })
  afterEach(() => {
    restoreSpawn?.()
  })
  afterAll(async () => {
    await dispose?.()
  })
}
