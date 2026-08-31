import type { CommandRecord, PageState } from './browser-client-host-command-state'

export class BrowserClientHostCommandResultCache {
  private readonly pagesByRecord = new Map<CommandRecord, PageState>()

  constructor(
    private readonly maxPerPage: number,
    private readonly maxTotal: number
  ) {}

  record(page: PageState, record: CommandRecord): void {
    page.settledSequences.push(record.event.commandSequence)
    this.pagesByRecord.set(record, page)
    while (page.settledSequences.length > this.maxPerPage) {
      const sequence = page.settledSequences[0]
      this.evict(page, sequence)
    }
    while (this.pagesByRecord.size > this.maxTotal) {
      const entry = this.pagesByRecord.entries().next().value
      if (!entry) {
        break
      }
      const [oldestRecord, oldestPage] = entry
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
  }

  private evict(page: PageState, sequence: number, expected?: CommandRecord): void {
    const cached = page.records.get(sequence)
    if (!cached || cached.status !== 'settled' || (expected && cached !== expected)) {
      return
    }
    page.records.delete(sequence)
    page.sequencesByCommandId.delete(cached.event.commandId)
    this.pagesByRecord.delete(cached)
    const sequenceIndex = page.settledSequences.indexOf(sequence)
    if (sequenceIndex !== -1) {
      page.settledSequences.splice(sequenceIndex, 1)
    }
  }
}
