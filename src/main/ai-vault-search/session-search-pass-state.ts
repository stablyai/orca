import type { SessionSearchIndexStore, SessionSearchFileRow } from './session-search-store'
import {
  SessionSearchCatalogClient,
  type SessionSearchCatalogRequest
} from './session-search-catalog-client'
import { SessionSearchCatalogFrontier } from './session-search-catalog-frontier'
import { SessionSearchDiscoveryInventory } from './session-search-discovery-inventory'
import { SessionSearchCandidateInventory } from './session-search-candidate-inventory'
import { SessionSearchWorkQueue } from './session-search-work-queue'

export class SessionSearchPassState {
  discovery: SessionSearchDiscoveryInventory
  candidates = new SessionSearchCandidateInventory()
  queue = new SessionSearchWorkQueue()
  retirement: {
    iterator: AsyncIterator<SessionSearchFileRow>
    rows: Pick<SessionSearchFileRow, 'path' | 'agent'>[]
    lookahead?: Pick<SessionSearchFileRow, 'path' | 'agent'>
    exhausted: boolean
  } | null = null
  private catalog: SessionSearchCatalogRequest | undefined
  private readonly request: SessionSearchCatalogRequest = (command) => this.catalog!(command)
  retire = this.retirementFrontier('retirement')
  parkedRetire = this.retirementFrontier('parked-retirement')
  private retirementFrontier(scope: string) {
    return new SessionSearchCatalogFrontier(
      new SessionSearchCatalogClient<{ value: string; order: number; revision: number }>(
        scope,
        this.request
      )
    )
  }
  needsRetirement = true
  private epoch: number | undefined
  recovering = false
  constructor(private readonly entryPath?: string) {
    this.discovery = new SessionSearchDiscoveryInventory(entryPath)
  }
  async prepare(store: SessionSearchIndexStore): Promise<void> {
    const epoch = store.catalogEpoch ?? 0
    if (this.epoch !== undefined && epoch !== this.epoch) {
      this.candidates.closePublications()
      await this.discovery.close()
      this.discovery = new SessionSearchDiscoveryInventory(this.entryPath)
      this.candidates.reset()
      this.queue = new SessionSearchWorkQueue()
      this.retirement = null
      this.retire = this.retirementFrontier('retirement')
      this.parkedRetire = this.retirementFrontier('parked-retirement')
      this.needsRetirement = true
      this.recovering = true
    }
    this.catalog = (command) => store.catalog(command)
    this.epoch = epoch
    this.candidates.attach(store)
    this.queue.attach(store)
    this.discovery.attach((command) => store.catalog(command))
  }
  get pending(): boolean {
    return (
      this.discovery.pending ||
      this.queue.size > 0 ||
      this.candidates.pendingPublications ||
      this.retirement !== null ||
      this.retire.size > 0 ||
      this.parkedRetire.waking
    )
  }
  close(): Promise<void> {
    this.candidates.closePublications()
    return this.discovery.close()
  }
}
