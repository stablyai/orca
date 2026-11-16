import type {
  CommandRecord,
  DispatcherLimits,
  PageState
} from './browser-client-host-command-state'
import { browserCommandCacheBytes } from './browser-command-cache-bytes'

export class BrowserClientHostCommandResultCache {
  private readonly pagesByRecord = new Map<CommandRecord, { page: PageState; bytes: number }>()
  private bytesByPage = new WeakMap<PageState, number>()
  private bytes = 0

  constructor(
    private readonly limits: Pick<
      DispatcherLimits,
      | 'maxCachedResultsPerPage'
      | 'maxCachedCommandResults'
      | 'maxCachedResultBytes'
      | 'maxCachedResultBytesPerPage'
    >
  ) {}

  record(page: PageState, record: CommandRecord, retain = true): void {
    if (!retain) {
      this.evict(page, record.event.commandSequence, record)
      return
    }
    const bytes = browserCommandCacheBytes(record.event, record.result)
    if (
      bytes === null ||
      bytes > this.limits.maxCachedResultBytes ||
      bytes > this.limits.maxCachedResultBytesPerPage
    ) {
      this.evict(page, record.event.commandSequence, record)
      return
    }
    page.settledSequences.push(record.event.commandSequence)
    this.pagesByRecord.set(record, { page, bytes })
    this.bytesByPage.set(page, (this.bytesByPage.get(page) ?? 0) + bytes)
    this.bytes += bytes
    while (
      page.settledSequences.length > this.limits.maxCachedResultsPerPage ||
      (this.bytesByPage.get(page) ?? 0) > this.limits.maxCachedResultBytesPerPage
    ) {
      const sequence = page.settledSequences[0]
      this.evict(page, sequence)
    }
    while (
      this.pagesByRecord.size > this.limits.maxCachedCommandResults ||
      this.bytes > this.limits.maxCachedResultBytes
    ) {
      const entry = this.pagesByRecord.entries().next().value
      if (!entry) {
        break
      }
      const [oldestRecord, { page: oldestPage }] = entry
      this.evict(oldestPage, oldestRecord.event.commandSequence, oldestRecord)
    }
  }

  releasePage(page: PageState): void {
    for (const sequence of page.settledSequences.slice()) {
      this.evict(page, sequence)
    }
  }

  clear(): void {
    this.pagesByRecord.clear()
    this.bytesByPage = new WeakMap()
    this.bytes = 0
  }

  private evict(page: PageState, sequence: number, expected?: CommandRecord): void {
    const cached = page.records.get(sequence)
    if (!cached || cached.status !== 'settled' || (expected && cached !== expected)) {
      return
    }
    page.records.delete(sequence)
    page.sequencesByCommandId.delete(cached.event.commandId)
    const retained = this.pagesByRecord.get(cached)
    if (retained) {
      this.bytes -= retained.bytes
      this.bytesByPage.set(page, (this.bytesByPage.get(page) ?? 0) - retained.bytes)
      this.pagesByRecord.delete(cached)
    }
    const sequenceIndex = page.settledSequences.indexOf(sequence)
    if (sequenceIndex !== -1) {
      page.settledSequences.splice(sequenceIndex, 1)
    }
  }
}
