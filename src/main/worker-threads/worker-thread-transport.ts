import type { Worker } from 'node:worker_threads'

export type WorkerRequestTransport = Pick<Worker, 'unref' | 'postMessage' | 'terminate'> & {
  on(...args: Parameters<Worker['on']>): unknown
  off(...args: Parameters<Worker['off']>): unknown
  removeAllListeners(): unknown
}

export type WorkerThreadFactory = () => WorkerRequestTransport
