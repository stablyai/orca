import { SessionSearchCatalogTransport } from './session-search-catalog-transport'
import type { SessionSearchWorkCommand, SessionSearchWorkResult } from './session-search-work-queue'
import type {
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'
import type {
  SessionSearchCatalogCommand,
  SessionSearchCatalogResult
} from './session-search-catalog'
import {
  createAiVaultScanCancelledError,
  abandonRemoteSessionScanOnCancel
} from '../ai-vault/ai-vault-scan-cancellation'
import {
  SessionSearchWorkerClient,
  SessionSearchOperationError
} from './session-search-worker-client'
import { reportSessionSearchBackgroundError } from './session-search-trace'
import { SessionSearchCursorSnapshot } from './session-search-cursor-snapshot'
import type { SessionSearchFileState, SessionSearchStateCounts } from './session-search-store'
import type {
  SearchWorkerCommand,
  SearchWorkerResponse,
  SessionSearchSnapshotRow
} from './session-search-worker-protocol'

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
  private coverageBytes = 0
  private readonly catalogTransport = new SessionSearchCatalogTransport(
    () => this.client.epoch,
    () => (this.acceptingReads ? Promise.resolve() : this.prepare()),
    (command) => this.send(command)
  )
  protected closed = false
  protected counts: SessionSearchStateCounts = {
    current: 0,
    due: 0,
    failed: 0,
    messages: 0,
    sessionsByAgent: {}
  }
  catalogPending = false
  generation = 0
  protected cutoff: number | null = null

  constructor(
    protected readonly path: string,
    protected readonly onError: (error: unknown) => void,
    private readonly onInvalidated: () => void = () => undefined,
    private readonly onFileChanged: (path: string) => void = () => undefined
  ) {
    super()
    this.client = new SessionSearchWorkerClient(
      (response) => this.update(response),
      undefined,
      true
    )
  }
  get catalogEpoch(): number {
    return this.client.epoch
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
      await this.client.request({
        op: 'open',
        path: this.path,
        reader: false,
        cutoff: this.cutoff,
        runtimeEpoch: epoch
      })
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
    if (response.catalogPending !== undefined) {
      this.catalogPending = response.catalogPending
    }
    if (response.reset) {
      if (this.invalidations.size) {
        this.onInvalidated()
      }
      for (const owner of this.invalidations.keys()) {
        owner.abort()
      }
      this.invalidations.clear()
      this.snapshotEpoch++
      this.coverage.clear()
      this.coverageBytes = 0
      this.speculative.clear()
      this.knownCoverage.clear()
    }
    for (const { path, row } of response.deltas ?? []) {
      this.projectCoverage(path, row ?? undefined)
      this.onFileChanged(path)
    }
    if (response.deltas?.length) {
      this.trimCoverage()
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
  async prepareCoverage(paths: readonly string[]): Promise<void> {
    if (paths.length > 256) {
      throw new Error('Session search coverage exceeds page budget')
    }
    await this.prepare()
    const response = await this.send({ op: 'coverage', paths: [...paths] })
    const rows = new Map(response.coverage?.map((row) => [row.path, row]))
    for (const path of paths) {
      this.projectCoverage(path, rows.get(path))
    }
    this.trimCoverage()
  }
  private trimCoverage(): void {
    if (this.knownCoverage.size <= 256 && this.coverageBytes <= 256 * 1024) {
      return
    }
    const active = new Set(this.invalidations.values())
    for (const path of this.knownCoverage) {
      if (
        this.knownCoverage.size <= 256 &&
        (this.coverageBytes <= 256 * 1024 || this.knownCoverage.size === 1)
      ) {
        break
      }
      if (active.has(path)) {
        continue
      }
      const row = this.coverage.get(path)
      if (row) {
        this.coverageBytes -= JSON.stringify(row).length * 2
      }
      this.coverage.delete(path)
      this.knownCoverage.delete(path)
    }
  }
  private projectCoverage(path: string, row: SessionSearchSnapshotRow | undefined): void {
    const old = this.coverage.get(path)
    this.coverageBytes -= old ? JSON.stringify(old).length * 2 : 0
    this.coverage.delete(path)
    this.knownCoverage.delete(path)
    this.knownCoverage.add(path)
    if (row) {
      this.coverage.set(path, row)
      this.coverageBytes += JSON.stringify(row).length * 2
    }
  }
  async *fileRows() {
    let after: string | undefined
    do {
      const response = await this.send({ op: 'file-page', after })
      const rows = response.filePage ?? []
      for (const row of rows) {
        yield row
      }
      after = rows.at(-1)?.path
    } while (after !== undefined)
  }
  async candidates(command: SessionSearchCandidateCommand): Promise<SessionSearchCandidateResult> {
    const response = await this.catalogTransport.request({ op: 'candidates', command })
    if (!response.candidates) {
      throw new Error('Session search candidate catalog unavailable')
    }
    return response.candidates
  }
  async work(command: SessionSearchWorkCommand): Promise<SessionSearchWorkResult> {
    const response = await this.catalogTransport.request({ op: 'work', command })
    if (!response.work) {
      throw new Error('Session search work catalog unavailable')
    }
    return response.work
  }
  async catalog(command: SessionSearchCatalogCommand): Promise<SessionSearchCatalogResult> {
    const response = await this.catalogTransport.request({ op: 'catalog', command })
    if (!response.catalog) {
      throw new Error('Session search catalog unavailable')
    }
    return response.catalog
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
  async removeFile(path: string): Promise<boolean> {
    if (!this.acceptingReads) {
      return false
    }
    const epoch = this.client.epoch,
      snapshotEpoch = this.snapshotEpoch
    try {
      const response = await this.send({ op: 'remove', path })
      return (
        this.acceptingReads &&
        epoch === this.client.epoch &&
        snapshotEpoch === this.snapshotEpoch &&
        response.accepted === true &&
        !response.failure &&
        !this.coverage.has(path)
      )
    } catch {
      return false
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
    this.coverage.clear()
    this.speculative.clear()
  }
  retired(): Promise<void> {
    return this.client.retired()
  }
}
