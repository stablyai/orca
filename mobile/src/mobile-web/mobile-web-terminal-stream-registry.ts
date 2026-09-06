import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export class MobileWebTerminalStreamRegistry {
  private readonly recordsByPageId = new Map<string, MobileWebTerminalStreamRecord>()
  private readonly recordsByHostId = new Map<number, MobileWebTerminalStreamRecord>()
  private nextHostStreamId = 0x70000000

  constructor(private readonly workspaceAuthority: MobileWebWorkspaceAuthority) {}

  hasPageStream(streamId: string): boolean {
    return this.recordsByPageId.has(streamId)
  }

  pageRecord(streamId: string): MobileWebTerminalStreamRecord | undefined {
    return this.recordsByPageId.get(streamId)
  }

  hostRecord(streamId: number): MobileWebTerminalStreamRecord | undefined {
    return this.recordsByHostId.get(streamId)
  }

  records(): IterableIterator<MobileWebTerminalStreamRecord> {
    return this.recordsByPageId.values()
  }

  register(record: MobileWebTerminalStreamRecord): void {
    this.recordsByPageId.set(record.pageStreamId, record)
    this.recordsByHostId.set(record.hostStreamId, record)
  }

  retire(record: MobileWebTerminalStreamRecord): void {
    this.recordsByPageId.delete(record.pageStreamId)
    this.recordsByHostId.delete(record.hostStreamId)
  }

  retireUnauthorized(): MobileWebTerminalStreamRecord[] {
    const retired: MobileWebTerminalStreamRecord[] = []
    for (const record of this.recordsByPageId.values()) {
      if (!this.isAuthorized(record)) {
        this.retire(record)
        retired.push(record)
      }
    }
    return retired
  }

  isAuthorized(record: MobileWebTerminalStreamRecord): boolean {
    try {
      return (
        this.workspaceAuthority.hostWorkspaceId(record.pageWorkspaceId) === record.hostWorkspaceId
      )
    } catch {
      return false
    }
  }

  allocateHostStreamId(): number {
    while (this.recordsByHostId.has(this.nextHostStreamId)) {
      this.nextHostStreamId += 1
    }
    return this.nextHostStreamId++
  }

  clear(): void {
    this.recordsByPageId.clear()
    this.recordsByHostId.clear()
  }

  get size(): number {
    return this.recordsByPageId.size
  }
}
