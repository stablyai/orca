import { createAiVaultScanCancelledError } from '../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import type {
  SessionSearchIndexStore,
  SessionSearchFileRow
} from './storage/session-search-store-types'
import {
  SessionSearchCatalogClient,
  recordSessionSearchCatalogCounts,
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
  retirementTurn: 'queued' | 'sweep' = 'queued'
  private request: SessionSearchCatalogRequest = async () => {
    throw createAiVaultScanCancelledError()
  }
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
      this.retirementTurn = 'queued'
      this.needsRetirement = true
      this.recovering = true
    }
    if (this.epoch !== epoch) {
      this.request = (command) => store.catalog(command, epoch)
      this.retire = this.retirementFrontier('retirement')
      this.parkedRetire = this.retirementFrontier('parked-retirement')
      this.epoch = epoch
    }
    this.candidates.attach(store)
    this.queue.attach(store)
    this.discovery.attach(this.request)
  }
  acceptCounts(scopeCounts: [string, number, number][]): void {
    recordSessionSearchCatalogCounts(this.request, { scopeCounts })
    this.discovery.acceptReadCounts(scopeCounts)
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
