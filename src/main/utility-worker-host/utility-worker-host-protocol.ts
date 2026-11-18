import type { WorkerThreadRole } from '../worker-threads/worker-thread-roles'

/** What callers use of a worker thread; a node Worker and a hosted one both satisfy it. */
export type HostedWorkerThread = {
  postMessage(message: unknown): void
  ref(): void
  unref(): void
  terminate(): Promise<number>
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
  removeAllListeners(event?: string): unknown
}

export type UtilityWorkerSpawn = {
  filename: string
  name: WorkerThreadRole
  workerData?: unknown
  /** Where the worker logs sends big enough to take down a receiver; set only with log consent. */
  largeSendLog?: string
}

/** Main to host over the process channel; each spawn carries its worker's port. */
export type UtilityWorkerHostRequest = { type: 'spawn' } & UtilityWorkerSpawn

/** Host to main over the process channel. */
export type UtilityWorkerHostEvent = { type: 'ready' }

export type UtilityWorkerFailure = { name: string; message: string; code?: string }

/** Consumer to worker, over the worker's own port. */
export type UtilityWorkerPortRequest = { type: 'post'; message: unknown } | { type: 'terminate' }

/**
 * Worker to consumer, over the worker's own port, so main can later hand a port to another
 * process instead of relaying replies. Messages travel as v8-serialized bytes, split so no port
 * message passes the chunk size. `loaded` follows the entry's synchronous load: a worker that dies
 * before it could not run here; one that dies after it may have been running real work.
 */
export type UtilityWorkerPortEvent =
  | { type: 'loaded' }
  | { type: 'message'; bytes: Uint8Array; more: boolean }
  | { type: 'error'; error: UtilityWorkerFailure }
  | { type: 'exit'; code: number }

export const UTILITY_WORKER_MESSAGE_CHUNK_BYTES = 32 * 2 ** 20

/** The part of Electron's MessagePortMain both ends use; tests stand in a node port. */
export type UtilityWorkerPort = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: any }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}
