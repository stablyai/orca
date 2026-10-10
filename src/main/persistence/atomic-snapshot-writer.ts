import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteTempPath, removeStaleDurableWriteTempFiles } from '../durable-file-write'

const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export type AtomicSnapshotWriterOptions = {
  /** Creation mode for the published file, e.g. 0o600 for state other users must not read. */
  fileMode?: number
  /** Mode for the parent directory, re-applied best-effort off Windows on every write. */
  directoryMode?: number
  /** Skip the write when the serialized bytes equal the last committed snapshot. */
  skipUnchanged?: boolean
}

/**
 * Whole-file snapshot writer: async temp-plus-rename off the event loop, with a synchronous twin for
 * quit paths. One async write runs at a time and requests made meanwhile coalesce into the next one.
 */
export class AtomicSnapshotWriter {
  private writeGeneration = 0
  private lastCommittedGeneration = 0
  private lastCommittedContent: string | null = null
  private writeRequested = false
  private closed = false
  private pendingWrite: Promise<void> | null = null
  private pendingSerialize: (() => string) | null = null
  private readonly staleTempCleanup: Promise<void>
  private inFlightAsyncTmpFile: string | null = null

  constructor(
    private readonly resolveFile: () => string,
    private readonly options: AtomicSnapshotWriterOptions = {}
  ) {
    this.staleTempCleanup = removeStaleDurableWriteTempFiles(resolveFile(), {
      minimumAgeMs: STALE_WRITE_TEMP_AGE_MS
    })
  }

  write(serialize: () => string): Promise<void> {
    if (this.closed) {
      return Promise.resolve()
    }
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
    const file = this.resolveFile()
    this.prepareDirectorySync(dirname(file))
    if (this.inFlightAsyncTmpFile) {
      try {
        unlinkSync(this.inFlightAsyncTmpFile)
        this.inFlightAsyncTmpFile = null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          void this.write(serialize).catch((writeError) => {
            console.error('[atomic-snapshot-writer] Failed to write snapshot:', writeError)
          })
          throw error
        }
      }
    }
    const { tmpFile, json, generation } = this.preparePayload(file, serialize)
    if (this.isUnchanged(json)) {
      // Why: disk already holds these newest bytes; an older async write must not rename over them.
      this.lastCommittedGeneration = Math.max(this.lastCommittedGeneration, generation)
      return
    }
    writeFileSync(tmpFile, json, {
      encoding: 'utf-8',
      mode: this.options.fileMode
    })
    try {
      renameSync(tmpFile, file)
    } catch (error) {
      try {
        unlinkSync(tmpFile)
      } catch {
        // tmp already gone
      }
      throw error
    }
    this.lastCommittedGeneration = Math.max(this.lastCommittedGeneration, generation)
    this.lastCommittedContent = json
  }

  waitForPendingWrite(): Promise<void> {
    return this.pendingWrite ?? Promise.resolve()
  }

  /** Records bytes already on disk (e.g. just loaded) so an identical first write is skipped. */
  primeCommittedContent(content: string | null): void {
    this.lastCommittedContent = content
  }

  /** Drops queued requests and stops in-flight async writes from publishing. Sync writes still work. */
  close(): void {
    this.closed = true
    this.writeRequested = false
    this.pendingSerialize = null
  }

  private isUnchanged(json: string): boolean {
    return this.options.skipUnchanged === true && json === this.lastCommittedContent
  }

  private preparePayload(
    finalPath: string,
    serialize: () => string
  ): {
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

  private prepareDirectorySync(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: this.options.directoryMode })
    if (this.options.directoryMode !== undefined && process.platform !== 'win32') {
      try {
        chmodSync(dir, this.options.directoryMode)
      } catch {
        // best-effort
      }
    }
  }

  private async prepareDirectory(dir: string): Promise<void> {
    await mkdir(dir, {
      recursive: true,
      mode: this.options.directoryMode
    }).catch(() => {})
    if (this.options.directoryMode !== undefined && process.platform !== 'win32') {
      await chmod(dir, this.options.directoryMode).catch(() => {})
    }
  }

  private async drainWrites(): Promise<void> {
    await this.staleTempCleanup
    let firstError: unknown = null
    while (this.writeRequested && !this.closed) {
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
    const file = this.resolveFile()
    await this.prepareDirectory(dirname(file))
    if (this.closed) {
      return
    }
    const { tmpFile, json, generation } = this.preparePayload(file, serialize)
    if (this.isUnchanged(json)) {
      return
    }
    let renamed = false
    try {
      await writeFile(tmpFile, json, {
        encoding: 'utf-8',
        mode: this.options.fileMode
      })
      if (this.closed || this.lastCommittedGeneration >= generation) {
        return
      }
      this.inFlightAsyncTmpFile = tmpFile
      try {
        await rename(tmpFile, file)
        renamed = true
        this.lastCommittedGeneration = Math.max(this.lastCommittedGeneration, generation)
        this.lastCommittedContent = json
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
