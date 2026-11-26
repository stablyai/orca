import type { UsageCacheSnapshotWriter } from './usage-cache-snapshot-writer'
import { encodeUsageCacheJson, readUsageCacheJson } from './usage-cache-json'

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
        const parsed = await readUsageCacheJson<{ scanState: { enabled: boolean } }>(cacheFile)
        if (!parsed) {
          throw new Error('Saved inline usage cache is invalid')
        }
        parsed.scanState.enabled = enabled()
        await writer.write(() => (this.active ? encodeUsageCacheJson(parsed) : serializeReport()))
      })
    return this.pending
  }

  settle(): Promise<void> {
    return this.pending.catch(() => {})
  }
}
