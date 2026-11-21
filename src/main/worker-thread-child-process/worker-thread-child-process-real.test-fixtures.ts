import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import * as workerProcesses from './worker-thread-child-process'
import {
  createWorkerThreadChildProcessTestEntry,
  createWorkerThreadChildProcessTestHost
} from './worker-thread-child-process-worker.test-fixtures'

/** Provide the built worker entry missing from source-level real-Git tests. */
export function installRealWorkerThreadChildProcesses(options: { latchRemoval?: boolean } = {}) {
  let dispose: (() => Promise<void>) | undefined
  let host: ReturnType<typeof createWorkerThreadChildProcessTestHost> | undefined
  let restoreSpawn: (() => void) | undefined
  beforeAll(async () => {
    const entry = await createWorkerThreadChildProcessTestEntry(options)
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
    // The production worker never boots here; captures pick a worker by its readiness.
    const ready = vi.spyOn(workerProcesses, 'whenSpawnWorkerReady').mockResolvedValue(true)
    const readyNow = vi.spyOn(workerProcesses, 'spawnWorkerReadyNow').mockReturnValue(true)
    restoreSpawn = () => {
      spawn.mockRestore()
      ready.mockRestore()
      readyNow.mockRestore()
    }
  })
  afterEach(() => {
    restoreSpawn?.()
  })
  afterAll(async () => {
    await dispose?.()
  })
  return {
    holdRemoval: () => {
      if (!host) {
        throw new Error('Test process worker not initialized')
      }
      return host.holdRemoval()
    },
    releaseRemoval: () => host?.releaseRemoval()
  }
}
