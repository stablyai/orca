import {
  createAiVaultScanCancelledError,
  abandonRemoteSessionScanOnCancel
} from '../../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import {
  SessionSearchWorkerClient,
  SessionSearchOperationError
} from './session-search-worker-client'
import { reportSessionSearchBackgroundError } from '../session-search-trace'
import { SessionSearchCursorSnapshot } from './session-search-cursor-snapshot'
import type {
  SessionSearchFileState,
  SessionSearchStateCounts
} from '../storage/session-search-store-types'
import type { SearchWorkerCommand, SearchWorkerResponse } from './session-search-worker-protocol'

/** Scanner-side cursor facts only; SQLite and durable staging belong to the writer thread. */
export class SessionSearchWorkerStoreBase extends SessionSearchCursorSnapshot {
  protected readonly client: SessionSearchWorkerClient
  protected readonly transfers = new Set<Promise<unknown>>()
  protected readonly credits = new Set<Promise<unknown>>()
  protected readonly invalidations = new Map<AbortController, string>()
  protected initialization: Promise<void> | null = null
  protected initializedEpoch = -1
  protected snapshotEpoch = 0
  protected nextHandle = 0
  protected bytes = 0
  protected closed = false
  protected counts: SessionSearchStateCounts = {
    current: 0,
    due: 0,
    failed: 0,
    messages: 0,
    sessionsByAgent: {}
  }
  generation = 0
  protected cutoff: number | null = null

  constructor(
    protected readonly path: string,
    protected readonly onError: (error: unknown) => void,
    private readonly onInvalidated: () => void = () => undefined
  ) {
    super()
    this.client = new SessionSearchWorkerClient(
      (response) => this.update(response),
      undefined,
      true
    )
  }
  get acceptingReads(): boolean {
    return !this.closed && this.initializedEpoch === this.client.epoch
  }
  get retentionCutoff(): number | null {
    return this.cutoff
  }
  setRetentionCutoffMs(cutoff: number | null): void {
    this.cutoff = cutoff
  }
  async prepare(): Promise<void> {
    if (this.closed) {
      throw createAiVaultScanCancelledError()
    }
    if (this.acceptingReads) {
      await this.send({ op: 'sync' })
      return
    }
    this.initialization ??= (async () => {
      await this.client.retired()
      const epoch = this.client.epoch
      await this.client.request({ op: 'open', path: this.path, reader: false, cutoff: this.cutoff })
      this.initializedEpoch = epoch
    })()
      .catch((error) => {
        this.client.stop()
        throw error
      })
      .finally(() => {
        this.initialization = null
      })
    await this.initialization
  }
  protected update(response: SearchWorkerResponse): void {
    if (response.snapshot) {
      if (this.invalidations.size) {
        this.onInvalidated()
      }
      for (const owner of this.invalidations.keys()) {
        owner.abort()
      }
      this.invalidations.clear()
      this.snapshotEpoch++
      this.committed.clear()
      this.speculative.clear()
      for (const row of response.snapshot) {
        this.committed.set(row.path, row)
      }
    }
    for (const { path, row } of response.deltas ?? []) {
      if (row) {
        this.committed.set(path, row)
      } else {
        this.committed.delete(path)
      }
    }
    if (response.generation !== undefined) {
      this.generation = response.generation
    }
    if (response.counts) {
      this.counts = response.counts
    }
  }
  protected send(command: SearchWorkerCommand): Promise<SearchWorkerResponse> {
    const promise = this.client.request(command)
    this.transfers.add(promise)
    void promise
      .catch((error: unknown) => {
        if (error instanceof SessionSearchOperationError) {
          reportSessionSearchBackgroundError(this.onError, error)
          return
        }
        this.onInvalidated()
        for (const owner of this.invalidations.keys()) {
          owner.abort()
        }
        this.invalidations.clear()
        this.client.stop(createAiVaultScanCancelledError())
        this.speculative.clear()
      })
      .finally(() => this.transfers.delete(promise))
    return promise
  }
  async flush(): Promise<void> {
    while (this.transfers.size) {
      await Promise.allSettled(this.transfers)
    }
  }
  stateCounts(): SessionSearchStateCounts {
    return this.counts
  }
  writeCommitted(): void {}
  reportWriteFailure(error: unknown): void {
    this.onError(error)
  }
  setFileState(path: string, state: SessionSearchFileState, mtime?: number): void {
    if (this.acceptingReads) {
      void this.send({ op: 'state', path, state, mtime })
    }
  }
  removeFile(path: string): void {
    if (this.acceptingReads) {
      void this.send({ op: 'remove', path })
    }
  }
  async purgeOlderThan(cutoff: number | null, signal?: AbortSignal): Promise<void> {
    await this.prepare()
    await abandonRemoteSessionScanOnCancel(this.send({ op: 'purge', cutoff }), signal)
  }
  close(): void {
    this.closed = true
    for (const owner of this.invalidations.keys()) {
      owner.abort()
    }
    this.invalidations.clear()
    this.client.stop()
    this.committed.clear()
    this.speculative.clear()
  }
  retired(): Promise<void> {
    return this.client.retired()
  }
}
