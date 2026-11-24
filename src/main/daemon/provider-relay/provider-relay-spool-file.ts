import { open, unlink, type FileHandle } from 'node:fs/promises'
import { SpoolFileIndex } from './provider-relay-spool-file-index'
import type { HeldRecord } from './provider-relay-spool-memory'
import { compactSpoolFile } from './provider-relay-spool-compaction'

/** Coalesced appends stop growing here, so joining records can never pass the engine's string limit. */
const MAX_COALESCED_WRITE_CHARS = 8 * 1024 * 1024

type SpoolWrite = { chunk: string; records: HeldRecord[]; bytes: number }

type SpoolFileHooks = {
  /** The spool's ack: rows at or below it are never needed again. */
  acked: () => number
  /** Records a failed write didn't land; the spool keeps them in memory, in seq order. */
  restore: (records: HeldRecord[]) => void
  /** Pending bytes fell as a write started, so a pause they caused can lift. */
  pendingChanged: () => void
}

/** The spool's private append-only file: one write in flight, the rest coalesced behind it. */
export class SpoolFile {
  readonly index = new SpoolFileIndex()
  /** A failed write keeps every later record in memory, so a full or broken disk loses nothing. */
  failed = false
  /** Bytes queued but not yet started; acks can't free them, so pressure counts them. */
  pendingBytes = 0
  io: Promise<void> = Promise.resolve()
  private handle: FileHandle | null = null
  /** The not-yet-started write, so appends coalesce without reordering around a removal. */
  private queued: SpoolWrite | null = null
  /** Bumped when the file is removed, so batches queued before that never write into a new one. */
  private epoch = 0
  /** Bytes written to this file, acked rows included, so a file kept across acks can be compacted. */
  private writtenBytes = 0
  private compacting = false
  private disposed = false

  constructor(
    private readonly path: string,
    private readonly hooks: SpoolFileHooks
  ) {}

  /** False when the record can't be encoded (too large to escape); it and later ones stay in memory. */
  write(record: HeldRecord): boolean {
    if (this.disposed) {
      return true
    }
    let encoded: string
    try {
      encoded = `${JSON.stringify({ seq: record.seq, line: record.line })}\n`
    } catch {
      this.failed = true
      return false
    }
    const bytes = Buffer.byteLength(encoded)
    this.index.add(record.seq, bytes)
    this.pendingBytes += bytes
    this.writtenBytes += bytes
    const queued = this.queued
    if (queued && queued.chunk.length + encoded.length <= MAX_COALESCED_WRITE_CHARS) {
      queued.chunk += encoded
      queued.records.push(record)
      queued.bytes += bytes
      return true
    }
    const write: SpoolWrite = { chunk: encoded, records: [record], bytes }
    const epoch = this.epoch
    this.queued = write
    this.io = this.io
      .then(async () => {
        if (this.queued === write) {
          this.queued = null
        }
        // Once started, a write is the one in flight; only those still queued count as pending.
        this.pendingBytes -= write.bytes
        this.hooks.pendingChanged()
        if (epoch !== this.epoch) {
          return
        }
        if (write.chunk.length === 0 || this.failed) {
          this.restore(write)
          return
        }
        try {
          this.handle ??= await open(this.path, 'a', 0o600)
          // appendFile keeps writing until every byte lands; a bare write may stop short.
          await this.handle.appendFile(write.chunk)
        } catch {
          this.failed = true
          // An ack may have retired the whole file while this write was in flight.
          if (epoch === this.epoch) {
            this.restore(write)
          }
        }
      })
      .catch(() => {})
    return true
  }

  /** Acked rows are dropped in bulk once they pass `capBytes`, so a kept file stays bounded. */
  compactIfWasteful(capBytes: number): void {
    if (this.compacting || this.failed || this.writtenBytes - this.index.unackedBytes < capBytes) {
      return
    }
    this.compacting = true
    const epoch = this.epoch
    // Later appends start their own write, after the rewrite.
    this.queued = null
    this.io = this.io
      .then(async () => {
        if (epoch !== this.epoch || this.disposed || this.failed) {
          return
        }
        await this.closeOpenHandle()
        try {
          const { before, after } = await compactSpoolFile(this.path, this.hooks.acked())
          // A removal while this ran started a new file; the savings were in the old one.
          if (epoch === this.epoch) {
            this.writtenBytes -= before - after
          }
        } catch {
          // The file is still whole, only larger; later lines stay in memory so it stops growing.
          this.failed = true
        }
      })
      .catch(() => {})
      .finally(() => {
        this.compacting = false
      })
  }

  /** An ended, detached relay writes nothing more; its fd closes and the file waits for a reader. */
  closeWhenIdle(stillIdle: () => boolean): void {
    this.io = this.io
      .then(async () => {
        if (stillIdle() && !this.queued) {
          await this.closeOpenHandle()
        }
      })
      .catch(() => {})
  }

  /** Also runs with no record indexed: a first append that failed may still have created the file. */
  remove(): void {
    // A queued write holds only acked records, so it is dropped rather than written.
    if (this.queued) {
      this.queued.chunk = ''
      this.queued = null
    }
    this.epoch++
    this.index.clear()
    this.writtenBytes = 0
    this.io = this.io
      .then(async () => {
        await this.closeOpenHandle()
        await unlink(this.path).catch(() => {})
      })
      .catch(() => {})
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.remove()
    return this.io
  }

  private async closeOpenHandle(): Promise<void> {
    const handle = this.handle
    this.handle = null
    await handle?.close()
  }

  /** Records a failed write didn't land leave the index and go back to the spool, still unacked. */
  private restore(write: SpoolWrite): void {
    if (write.chunk.length === 0 || this.disposed) {
      return
    }
    this.index.drop(new Set(write.records.map((record) => record.seq)))
    this.hooks.restore(write.records.filter((record) => record.seq > this.hooks.acked()))
  }
}
