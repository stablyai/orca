import type { WorkerRequestTransport, WorkerThreadFactory } from '../lazy-worker-thread-host'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import type { UsageScanWorkerRequest } from './usage-scan-worker-protocol'
import { usageSourceCachePath } from './usage-source-cache-file'

export function createUsageScanWorkerTransport(
  factory: WorkerThreadFactory
): WorkerRequestTransport {
  const worker = factory()
  if (!('threadId' in worker) || typeof worker.threadId !== 'number' || worker.threadId < 1) {
    return worker
  }
  const owner = String(worker.threadId)
  const cachePaths = new Set<string>()
  return {
    on: (...args) => worker.on(...args),
    off: (...args) => worker.off(...args),
    removeAllListeners: () => worker.removeAllListeners(),
    unref: () => worker.unref(),
    postMessage: (request: UsageScanWorkerRequest, transferList) => {
      cachePaths.add(
        request.operation === 'scan'
          ? request.sourceCache.path
          : usageSourceCachePath(request.cacheFile)
      )
      worker.postMessage(request, transferList)
    },
    terminate: async () => {
      const code = await worker.terminate()
      // Only this exited worker's files are safe to reclaim while its replacement is running.
      await Promise.all(
        [...cachePaths].map((path) =>
          removeStaleDurableWriteTempFiles(path, { retiredOwner: owner })
        )
      )
      return code
    }
  }
}
