import type { WorkerThreadRole } from '../worker-threads/worker-thread-roles'

/** What callers use of a worker thread; a node Worker and a hosted one both satisfy it. */
export type HostedWorkerThread = {
  postMessage(message: unknown): void
  ref(): void
  unref(): void
  terminate(): Promise<number>
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
}

export type UtilityWorkerSpawn = {
  filename: string
  name: WorkerThreadRole
  workerData?: unknown
  /** Where the worker logs sends big enough to take down a receiver; set only with log consent. */
  largeSendLog?: string
}

export type UtilityWorkerHostRequest =
  | ({ type: 'spawn'; id: number } & UtilityWorkerSpawn)
  | { type: 'post'; id: number; message: unknown }
  | { type: 'terminate'; id: number }

export type UtilityWorkerFailure = { name: string; message: string; code?: string }

/** Worker messages travel as v8-serialized bytes, split so no IPC message passes the chunk size. */
export type UtilityWorkerHostEvent =
  | { type: 'ready' }
  | { type: 'message'; id: number; bytes: Uint8Array; more: boolean }
  | { type: 'error'; id: number; error: UtilityWorkerFailure }
  | { type: 'exit'; id: number; code: number }

export const UTILITY_WORKER_MESSAGE_CHUNK_BYTES = 32 * 2 ** 20
