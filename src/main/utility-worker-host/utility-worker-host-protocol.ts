import type { WorkerThreadRole } from '../worker-threads/worker-thread-roles'

/** What callers use of a worker thread; a node Worker and a hosted one both satisfy it. */
export type HostedWorkerThread = {
  postMessage(message: unknown): void
  ref(): void
  unref(): void
  terminate(): Promise<number>
  /** Relayed bytes main has not released yet; only a hosted worker under a relay budget has any. */
  readonly unreleasedBytes?: number
  /** Under a relay budget a hosted 'message' also passes a release, called once it is consumed. */
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
}

export type UtilityWorkerSpawn = {
  filename: string
  name: WorkerThreadRole
  workerData?: unknown
  /** Merged into workerData only when the worker runs in main's process (shared memory can't cross). */
  inProcessWorkerData?: Record<string, unknown>
  /** Where the worker logs sends big enough to take down a receiver; set only with log consent. */
  largeSendLog?: string
}

export type UtilityWorkerHostRequest =
  | ({ type: 'spawn'; id: number } & UtilityWorkerSpawn)
  | { type: 'post'; id: number; message: unknown }
  | { type: 'terminate'; id: number }
  /** Bytes main may hold delivered but unconsumed; sent once, before any spawn. */
  | { type: 'budget'; bytes: number }
  /** Main consumed the reply relayed with this seq. */
  | { type: 'ack'; seq: number }

export type UtilityWorkerFailure = { name: string; message: string; code?: string }

/** Worker messages travel as v8-serialized bytes, split so no IPC message passes the chunk size. */
export type UtilityWorkerHostEvent =
  | { type: 'ready' }
  | { type: 'message'; id: number; bytes: Uint8Array; more: boolean; seq?: number }
  | { type: 'error'; id: number; error: UtilityWorkerFailure }
  | { type: 'exit'; id: number; code: number }

export const UTILITY_WORKER_MESSAGE_CHUNK_BYTES = 32 * 2 ** 20
