import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurableIfCurrent
} from './durable-file-write'

/**
 * Serialized durable writer for the per-provider usage caches. One per store: the multi-MB JSON must
 * not block the Electron main thread, writes are queued so two overlapping renames can't both veto
 * themselves, and a snapshot superseded before its turn is dropped instead of paying for a rewrite.
 */
export class UsageCacheSnapshotWriter {
  private generation = 0
  private pending: Promise<void>

  constructor(
    private readonly logTag: string,
    private readonly resolveFile: () => string
  ) {
    // Why: a crash between write and rename orphans a multi-MB temp file; reclaim once per launch.
    // Seeding the write queue with it also orders the sweep ahead of the first write of this launch.
    this.pending = removeStaleDurableWriteTempFiles(resolveFile())
  }

  /** `serialize` runs only if this snapshot is still the newest one when its turn comes. */
  write(serialize: () => string): Promise<void> {
    const generation = ++this.generation
    const write = this.pending.then(() => this.commit(generation, serialize))
    // Why: keep the queue usable after a failure — the awaiting caller still sees the rejection.
    this.pending = write.catch((error: unknown) => {
      console.error(`${this.logTag} Failed to persist usage cache:`, error)
    })
    return write
  }

  /** Await every write queued so far. Never rejects — the queue already logs its own failures. */
  flush(): Promise<void> {
    return this.pending
  }

  private async commit(generation: number, serialize: () => string): Promise<void> {
    // Why: a newer snapshot is already queued behind this one, so rewriting the cache here is wasted.
    if (generation !== this.generation) {
      return
    }
    // Why serialize here and not at queue time: it blocks the main process for a multi-MB cache, and
    // superseded generations must not pay for it. Synchronous, so no mutation can tear the JSON.
    const payload = serialize()
    const usageFile = this.resolveFile()
    await mkdir(dirname(usageFile), { recursive: true }).catch(() => {})
    // Why: atomic temp-file + durable rename so a crash cannot leave a truncated analytics file.
    await writeFileDurableIfCurrent(
      durableWriteTempPath(usageFile),
      usageFile,
      payload,
      () => generation === this.generation
    )
  }
}
