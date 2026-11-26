import type { Worker } from 'node:worker_threads'

export type WorkerRequestTransport = Pick<Worker, 'unref' | 'postMessage' | 'terminate'> & {
  on(...args: Parameters<Worker['on']>): unknown
  off(...args: Parameters<Worker['off']>): unknown
  removeAllListeners(): unknown
}

export type WorkerThreadFactory = () => WorkerRequestTransport

// A closing thread answers at once; terminate one that never does.
const GRACEFUL_STOP_TIMEOUT_MS = 1000

// terminate() orphans the thread's SQLite connection, whose Windows file lock then outlives the database.
export function stopWorkerGracefully(
  worker: Pick<WorkerRequestTransport, 'postMessage' | 'terminate' | 'on' | 'off'>,
  onError: (cause: unknown) => void
): void {
  try {
    worker.postMessage({ type: 'close' })
  } catch {
    // Already exited; the fallback terminate below is a no-op then.
  }
  const hung = setTimeout(() => worker.terminate().catch(onError), GRACEFUL_STOP_TIMEOUT_MS)
  hung.unref()
  const onExit = (): void => {
    clearTimeout(hung)
    worker.off('exit', onExit)
  }
  worker.on('exit', onExit)
}
