import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteTempPath, removeStaleDurableWriteTempFiles } from '../durable-file-write'

const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export class StatsSnapshotWriter {
  private writeGeneration = 0
  private lastCommittedGeneration = 0
  private writeRequested = false
  private pendingWrite: Promise<void> | null = null
  private pendingSerialize: (() => string) | null = null
  private readonly staleTempCleanup: Promise<void>
  private inFlightAsyncTmpFile: string | null = null

  constructor(private readonly resolveFile: () => string) {
    this.staleTempCleanup = removeStaleDurableWriteTempFiles(resolveFile(), {
      minimumAgeMs: STALE_WRITE_TEMP_AGE_MS
    })
  }

  write(serialize: () => string): Promise<void> {
    this.writeRequested = true
    this.pendingSerialize = serialize
    if (this.pendingWrite) {
      return this.pendingWrite
    }
    const run = this.drainWrites()
    const tracked = run.finally(() => {
      if (this.pendingWrite === tracked) {
        this.pendingWrite = null
      }
    })
    this.pendingWrite = tracked
    return tracked
  }

  writeSync(serialize: () => string): void {
    const statsFile = this.resolveFile()
    const dir = dirname(statsFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    if (this.inFlightAsyncTmpFile) {
      try {
        unlinkSync(this.inFlightAsyncTmpFile)
        this.inFlightAsyncTmpFile = null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          void this.write(serialize).catch((writeError) => {
            console.error('[stats] Failed to write stats:', writeError)
          })
          throw error
        }
      }
    }
    const { tmpFile, json, generation } = this.preparePayload(statsFile, serialize)
    writeFileSync(tmpFile, json, 'utf-8')
    renameSync(tmpFile, statsFile)
    this.lastCommittedGeneration = Math.max(this.lastCommittedGeneration, generation)
  }

  waitForPendingWrite(): Promise<void> {
    return this.pendingWrite ?? Promise.resolve()
  }

  private preparePayload(finalPath: string, serialize: () => string): {
    tmpFile: string
    json: string
    generation: number
  } {
    const generation = ++this.writeGeneration
    return {
      tmpFile: durableWriteTempPath(finalPath),
      json: serialize(),
      generation
    }
  }

  private async drainWrites(): Promise<void> {
    await this.staleTempCleanup
    let firstError: unknown = null
    while (this.writeRequested) {
      this.writeRequested = false
      const serialize = this.pendingSerialize!
      try {
        await this.writeToDiskAsync(serialize)
      } catch (error) {
        firstError ??= error
        if (!this.writeRequested) {
          throw error
        }
      }
    }
    if (firstError) {
      throw firstError
    }
  }

  private async writeToDiskAsync(serialize: () => string): Promise<void> {
    const statsFile = this.resolveFile()
    await mkdir(dirname(statsFile), { recursive: true }).catch(() => {})
    const { tmpFile, json, generation } = this.preparePayload(statsFile, serialize)
    let renamed = false
    try {
      await writeFile(tmpFile, json, 'utf-8')
      if (this.lastCommittedGeneration >= generation) {
        return
      }
      this.inFlightAsyncTmpFile = tmpFile
      try {
        await rename(tmpFile, statsFile)
        renamed = true
        this.lastCommittedGeneration = Math.max(this.lastCommittedGeneration, generation)
      } catch (err) {
        if (
          (err as NodeJS.ErrnoException).code !== 'ENOENT' ||
          this.lastCommittedGeneration < generation
        ) {
          throw err
        }
      } finally {
        if (this.inFlightAsyncTmpFile === tmpFile) {
          this.inFlightAsyncTmpFile = null
        }
      }
    } finally {
      if (!renamed) {
        await rm(tmpFile, { force: true }).catch(() => {})
      }
    }
  }
}
