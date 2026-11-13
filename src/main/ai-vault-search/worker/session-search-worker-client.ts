import { AI_VAULT_SCAN_CANCELLED_MESSAGE } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { createAiVaultScanCancelledError } from '../../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import { recordRelayedSpan } from '../../observability/tracer'
import { existsSync } from 'node:fs'
import { LazyWorkerThreadHost } from '../../worker-threads/lazy-worker-thread-host'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'
import type { SearchWorkerCommand, SearchWorkerResponse } from './session-search-worker-protocol'

export function sessionSearchWorkerFactory() {
  const path = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'session-search-worker-entry.js'
  )
  if (!existsSync(path)) {
    throw new Error(`Session search worker entry not found: ${path}`)
  }
  return spawnWorkerThread(path, { resourceLimits: { maxOldGenerationSizeMb: 256 } })
}

export class SessionSearchOperationError extends Error {}

const MAX_PENDING_REQUESTS = 1024

type PendingCall = { resolve(value: SearchWorkerResponse): void; reject(error: Error): void }

/** Why: a failed port invalidates every staged handle; none can resume on a replacement. */
export class SessionSearchWorkerClient {
  private nextId = 0
  private readonly pending = new Map<number, PendingCall>()
  // Writer commands wait for room instead of failing, so a burst can't stop the writer.
  private readonly held: { command: SearchWorkerCommand; call: PendingCall }[] = []
  private readonly host: LazyWorkerThreadHost<SearchWorkerResponse>
  private retirement = Promise.resolve()
  epoch = 0

  constructor(
    private readonly onChange: (value: SearchWorkerResponse) => void = () => undefined,
    factory: WorkerThreadFactory = sessionSearchWorkerFactory,
    private readonly holdWhenFull = false
  ) {
    this.host = new LazyWorkerThreadHost({
      factory,
      idleTeardownMs: 0,
      awaitRetirement: true,
      isIdle: () => this.pending.size === 0 && this.held.length === 0,
      onMessage: (value) => {
        if (value.trace) {
          recordRelayedSpan(value.trace)
          return
        }
        this.onChange(value)
        const call = this.pending.get(value.id)
        if (!call) {
          return
        }
        this.pending.delete(value.id)
        this.postHeld()
        if (value.error === AI_VAULT_SCAN_CANCELLED_MESSAGE) {
          call.reject(createAiVaultScanCancelledError())
        } else if (value.error && !value.failure) {
          call.reject(new SessionSearchOperationError(value.error))
        } else {
          call.resolve(value)
        }
      },
      onError: (error) => this.stop(error),
      onExit: () => this.stop(new Error('Session search worker exited')),
      onUnavailable: () => undefined
    })
  }
  get retiring(): boolean {
    return this.host.isRetiring
  }
  get busy(): boolean {
    return this.pending.size > 0 || this.held.length > 0
  }
  async retired(): Promise<void> {
    await this.retirement
  }
  request(command: SearchWorkerCommand): Promise<SearchWorkerResponse> {
    if (this.holdWhenFull && (this.held.length || this.pending.size >= MAX_PENDING_REQUESTS)) {
      return new Promise((resolve, reject) =>
        this.held.push({ command, call: { resolve, reject } })
      )
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('Session search worker queue is full'))
    }
    return new Promise((resolve, reject) => this.post(command, { resolve, reject }))
  }
  private postHeld(): void {
    while (this.held.length && this.pending.size < MAX_PENDING_REQUESTS) {
      const next = this.held.shift()!
      this.post(next.command, next.call)
    }
  }
  private post(command: SearchWorkerCommand, call: PendingCall): void {
    const worker = this.host.ensure()
    if (!worker) {
      call.reject(new Error('Session search worker is unavailable'))
      return
    }
    const id = ++this.nextId
    this.pending.set(id, call)
    try {
      worker.postMessage({ id, command })
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error('Session search transfer failed'))
    }
  }
  stop(error = new Error('Session search read cancelled')): void {
    this.epoch++
    for (const call of this.pending.values()) {
      call.reject(error)
    }
    this.pending.clear()
    for (const { call } of this.held.splice(0)) {
      call.reject(error)
    }
    this.host.destroy()
    this.retirement = this.host.retired()
  }
}
