import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type {
  SessionSearchFileRow,
  SessionSearchIndexStore
} from './storage/session-search-store-types'
export type { SessionSearchWork } from './session-search-work-catalog'
import type { SessionSearchWork } from './session-search-work-catalog'

export type SessionSearchWorkReceipt = {
  path: string
  version: number
  fact: number
  factRevision: number
  ordering: number
  deferred: boolean
  force: boolean
  metadata: boolean
  runtimeEpoch?: number
}
export type SessionSearchReadSettlement = {
  disposition: 'settled' | 'content-accepted/settlement-rejected'
  work?: SessionSearchWorkResult
}
export type SessionSearchReadContext = {
  receipt: SessionSearchWorkReceipt
  settlement?: Promise<SessionSearchReadSettlement | undefined>
}

export type SessionSearchWorkCommand =
  | {
      kind: 'enqueue'
      candidate: SessionFileCandidate
      force: boolean
      recent: boolean
      metadata: boolean
    }
  | { kind: 'next'; eligibleThrough?: number }
  | { kind: 'stats' }
  | { kind: 'get'; path: string }
  | {
      kind: 'acknowledge'
      work: SessionSearchWork
      retry: boolean
      handoff?: { scope: string; revision: number }
      reconcile?: boolean
    }
  | { kind: 'remove'; path: string }
  | { kind: 'row'; path: string; row?: SessionSearchFileRow }
export type SessionSearchWorkResult = {
  size: number
  left: number
  work?: SessionSearchWork
  works?: SessionSearchWork[]
  revision?: number
  eligibleThrough?: number
}

/** Only active reads cross the boundary; the writer owns ready work and its transitions. */
export class SessionSearchWorkQueue {
  private store: SessionSearchIndexStore | undefined
  private epoch: number | undefined
  private count = 0
  private remaining = 0
  private page: SessionSearchWork[] = []
  private revision: number | undefined
  private selectedRevision: number | undefined
  private eligibleThrough: number | undefined
  beginPass(): void {
    this.page = []
    this.eligibleThrough = undefined
  }
  selectionCurrent(result: SessionSearchWorkResult): boolean {
    const current = this.selectedRevision === result.revision
    this.update(result)
    return current
  }
  attach(store: SessionSearchIndexStore): void {
    if (!this.store) {
      this.store = store
      this.epoch = store.catalogEpoch ?? 0
    }
  }
  get size(): number {
    return this.count
  }
  get left(): number {
    return this.remaining
  }
  get selectionRevision(): number | undefined {
    return this.selectedRevision
  }
  update(result: SessionSearchWorkResult): void {
    if (this.revision !== result.revision) {
      this.page = []
      this.revision = result.revision
    }
    this.count = result.size
    this.remaining = result.left
  }
  private async request(command: SessionSearchWorkCommand): Promise<SessionSearchWorkResult> {
    const result = await this.store!.work(command, this.epoch)
    this.update(result)
    return result
  }
  async enqueue(
    candidate: SessionFileCandidate,
    store: SessionSearchIndexStore,
    force = false,
    recent = true,
    metadata = false
  ): Promise<void> {
    this.attach(store)
    await this.request({ kind: 'enqueue', candidate, force, recent, metadata })
  }
  async hasPublicationDebt(path: string): Promise<boolean> {
    const work = await this.get(path)
    return !!work && (work.force || work.metadata)
  }
  async next(): Promise<SessionSearchWork | undefined> {
    if (!this.page.length) {
      const result = await this.request({ kind: 'next', eligibleThrough: this.eligibleThrough })
      this.eligibleThrough ??= result.eligibleThrough
      this.page = result.works ?? (result.work ? [result.work] : [])
    }
    this.selectedRevision = this.revision
    return this.page.shift()
  }
  async get(path: string): Promise<SessionSearchWork | undefined> {
    return (await this.request({ kind: 'get', path })).work
  }
  async acknowledge(
    work: SessionSearchWork,
    retry: boolean,
    handoff?: { scope: string; revision: number }
  ): Promise<void> {
    await this.request({ kind: 'acknowledge', work, retry, handoff, reconcile: true })
  }
  async remove(path: string): Promise<void> {
    await this.request({ kind: 'remove', path })
  }
  async rowChanged(path: string, row: SessionSearchFileRow | undefined): Promise<void> {
    await this.request({ kind: 'row', path, row })
  }
}
