import { readFile } from 'node:fs/promises'
import type { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'

export class UsageInlineCachePreservation {
  active = false
  private pending = Promise.resolve()

  write(
    cacheFile: string,
    enabled: () => boolean,
    writer: UsageCacheSnapshotWriter,
    serializeReport: () => string
  ): Promise<void> {
    if (!this.active) {
      return writer.write(serializeReport)
    }
    // Failed migration leaves this file as the only source-cache generation.
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        const parsed: { scanState: { enabled: boolean } } = JSON.parse(
          await readFile(cacheFile, 'utf8')
        )
        parsed.scanState.enabled = enabled()
        await writer.write(() => (this.active ? JSON.stringify(parsed) : serializeReport()))
      })
    return this.pending
  }

  settle(): Promise<void> {
    return this.pending.catch(() => {})
  }
}
