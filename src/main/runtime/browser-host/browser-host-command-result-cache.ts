import type {
  BrowserHostCommandPageState,
  BrowserHostCommandRecord
} from './browser-host-command-state'

export class BrowserHostCommandResultCache {
  private readonly settledRecords = new Map<BrowserHostCommandRecord, BrowserHostCommandPageState>()

  constructor(
    private readonly maxResults: number,
    private readonly maxResultsPerPage: number,
    private readonly onReleasedPageEmpty: (browserPageId: string) => void
  ) {}

  remember(page: BrowserHostCommandPageState, record: BrowserHostCommandRecord): void {
    this.settledRecords.set(record, page)
    while (page.settledSequences.length > this.maxResultsPerPage) {
      this.evict(page, page.settledSequences[0])
    }
    while (this.settledRecords.size > this.maxResults) {
      const oldest = this.settledRecords.entries().next().value
      if (!oldest) {
        break
      }
      this.evict(oldest[1], oldest[0].event.commandSequence, oldest[0])
    }
  }

  releasePage(page: BrowserHostCommandPageState): void {
    for (const sequence of page.settledSequences.slice()) {
      this.evict(page, sequence)
    }
  }

  clear(): void {
    this.settledRecords.clear()
  }

  private evict(
    page: BrowserHostCommandPageState,
    sequence: number,
    expected?: BrowserHostCommandRecord
  ): void {
    const record = page.records.get(sequence)
    if (!record?.settled || (expected && record !== expected)) {
      return
    }
    page.records.delete(sequence)
    this.settledRecords.delete(record)
    const index = page.settledSequences.indexOf(sequence)
    if (index !== -1) {
      page.settledSequences.splice(index, 1)
    }
    if (page.activeCapacityReleased && page.records.size === 0) {
      this.onReleasedPageEmpty(record.event.browserPageId)
    }
  }
}
