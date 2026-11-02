import { browserCommandCacheBytes } from '../../browser/browser-command-cache-bytes'
import type {
  resolveBrowserHostCommandCacheLimits,
  BrowserHostCommandPageState,
  BrowserHostCommandRecord
} from './browser-host-command-state'

export class BrowserHostCommandResultCache {
  private readonly settledRecords = new Map<
    BrowserHostCommandRecord,
    { page: BrowserHostCommandPageState; bytes: number }
  >()
  private bytesByPage = new WeakMap<BrowserHostCommandPageState, number>()
  private bytes = 0

  constructor(
    private readonly limits: ReturnType<typeof resolveBrowserHostCommandCacheLimits>,
    private readonly onReleasedPageEmpty: (browserPageId: string) => void
  ) {}

  remember(page: BrowserHostCommandPageState, record: BrowserHostCommandRecord): void {
    const bytes = browserCommandCacheBytes(record.event, record.settled)
    if (bytes === null || bytes > this.limits.maxBytes || bytes > this.limits.maxBytesPerPage) {
      this.evict(page, record.event.commandSequence, record)
      return
    }
    this.settledRecords.set(record, { page, bytes })
    this.bytesByPage.set(page, (this.bytesByPage.get(page) ?? 0) + bytes)
    this.bytes += bytes
    while (
      page.settledSequences.length > this.limits.maxResultsPerPage ||
      (this.bytesByPage.get(page) ?? 0) > this.limits.maxBytesPerPage
    ) {
      this.evict(page, page.settledSequences[0])
    }
    while (this.settledRecords.size > this.limits.maxResults || this.bytes > this.limits.maxBytes) {
      const oldest = this.settledRecords.entries().next().value
      if (!oldest) {
        break
      }
      this.evict(oldest[1].page, oldest[0].event.commandSequence, oldest[0])
    }
  }

  releasePage(page: BrowserHostCommandPageState): void {
    for (const sequence of page.settledSequences.slice()) {
      this.evict(page, sequence)
    }
  }

  clear(): void {
    this.settledRecords.clear()
    this.bytesByPage = new WeakMap()
    this.bytes = 0
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
    const retained = this.settledRecords.get(record)
    if (retained) {
      this.bytes -= retained.bytes
      this.bytesByPage.set(page, (this.bytesByPage.get(page) ?? 0) - retained.bytes)
      this.settledRecords.delete(record)
    }
    const index = page.settledSequences.indexOf(sequence)
    if (index !== -1) {
      page.settledSequences.splice(index, 1)
    }
    if (page.activeCapacityReleased && page.records.size === 0) {
      this.onReleasedPageEmpty(record.event.browserPageId)
    }
  }
}
