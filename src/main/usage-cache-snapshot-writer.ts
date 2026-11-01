import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurableIfCurrent
} from './durable-file-write'

// Serialize durable writes per store and skip superseded snapshots.
export class UsageCacheSnapshotWriter {
  private generation = 0
  private pending: Promise<void>

  constructor(
    private readonly logTag: string,
    private readonly resolveFile: () => string
  ) {
    // Reclaim crash-orphaned temp files before the first write.
    this.pending = removeStaleDurableWriteTempFiles(resolveFile())
  }

  /** `serialize` runs only if this snapshot is still the newest one when its turn comes. */
  write(serialize: () => string): Promise<void> {
    const generation = ++this.generation
    const write = this.pending.then(() => this.commit(generation, serialize))
    // Keep the queue usable after failure; the caller still receives the rejection.
    this.pending = write.catch((error: unknown) => {
      console.error(`${this.logTag} Failed to persist usage cache:`, error)
    })
    return write
  }

  /** Never rejects; queued failures are already logged. */
  flush(): Promise<void> {
    return this.pending
  }

  private async commit(generation: number, serialize: () => string): Promise<void> {
    if (generation !== this.generation) {
      return
    }
    // Defer expensive synchronous serialization until we know this snapshot is still current.
    const payload = serialize()
    const usageFile = this.resolveFile()
    await mkdir(dirname(usageFile), { recursive: true }).catch(() => {})
    await writeFileDurableIfCurrent(
      durableWriteTempPath(usageFile),
      usageFile,
      payload,
      () => generation === this.generation,
      // Usage caches hold session ids and project paths.
      0o600
    )
  }
}
