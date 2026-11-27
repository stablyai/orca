import { createHash } from 'node:crypto'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { crc32 } from 'node:zlib'
import { MAX_LEGACY_IMPORT_RECORD_BYTES as RECORD_BYTES } from './journal-legacy-transcript-stream'
import {
  ClaudeImportGrowthError,
  ClaudeImportResourceError,
  type ClaudeImportGrowth
} from './journal-claude-import-resource-error'

import {
  changed,
  sameFile,
  sameVersion,
  validRestage,
  type ClaudeSourceCheckpoint,
  type ClaudeSourceVersion
} from './journal-claude-import-source-version'

const SLAB_BYTES = 512 * 1024
const PROOF_STAT_BYTES = 8 * 1024 * 1024

export type ClaudeRange = {
  offset: number
  legacyOffset: number
  line: number
  length: number
  digest: number
}

export class ClaudeImportSource {
  private readonly size: number
  private checkpoint: ClaudeSourceCheckpoint | undefined
  private verified: BigIntStats | undefined

  private constructor(
    private readonly file: FileHandle,
    private readonly path: string,
    private readonly signal: AbortSignal | undefined,
    private readonly initial: BigIntStats
  ) {
    this.size = Number(initial.size)
    if (!Number.isSafeInteger(this.size)) {
      changed()
    }
  }

  static async open(
    path: string,
    signal?: AbortSignal,
    growth?: ClaudeImportGrowth
  ): Promise<ClaudeImportSource> {
    const before = await stat(path, { bigint: true })
    if (!before.isFile()) {
      changed()
    }
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    const file = await open(path, flags)
    try {
      const initial = await file.stat({ bigint: true })
      if (!sameFile(before, initial) || (growth && !validRestage(initial, growth))) {
        changed()
      }
      return new ClaudeImportSource(file, path, signal, initial)
    } catch (error) {
      await file.close()
      throw error
    }
  }

  close(): Promise<void> {
    return this.file.close()
  }

  async scan(
    onLine: (bytes: Buffer, range: ClaudeRange) => void,
    prefix?: ClaudeSourceCheckpoint
  ): Promise<void> {
    let offset = 0
    let legacyOffset = 0
    let line = 0
    let pending: Buffer[] = []
    let pendingBytes = 0
    const hash = createHash('sha256')
    const prefixBytes = prefix ? Number(prefix.size) : -1
    await this.readPrefix((slab, position) => {
      if (prefix && position <= prefixBytes && prefixBytes < position + slab.length) {
        const overlap = prefixBytes - position
        hash.update(slab.subarray(0, overlap))
        if (hash.copy().digest('hex') !== prefix.digest) {
          changed()
        }
        hash.update(slab.subarray(overlap))
      } else {
        hash.update(slab)
      }
      let start = 0
      for (let end = slab.indexOf(10); end !== -1; end = slab.indexOf(10, start)) {
        const part = slab.subarray(start, end)
        if (pendingBytes) {
          retain(part)
          emit(Buffer.concat(pending, pendingBytes), true)
          pending = []
          pendingBytes = 0
        } else {
          emit(part, true)
        }
        start = end + 1
      }
      if (start !== slab.length) {
        retain(slab.subarray(start))
      }
    })
    if (pendingBytes) {
      emit(Buffer.concat(pending, pendingBytes), false)
    }
    this.checkpoint = {
      size: this.initial.size,
      device: this.initial.dev,
      inode: this.initial.ino,
      digest: hash.digest('hex')
    }

    function retain(part: Buffer): void {
      pendingBytes += part.length
      checkRecordSize(pendingBytes)
      pending.push(part)
    }

    function emit(bytes: Buffer, terminated: boolean): void {
      const recordBytes = isUtf8(bytes) ? bytes.length : legacyUtf8Length(bytes)
      checkRecordSize(recordBytes)
      if (bytes.length !== 0 && !(bytes.length === 1 && bytes[0] === 13)) {
        onLine(bytes, { offset, legacyOffset, line, length: bytes.length, digest: crc32(bytes) })
        line++
      }
      offset += bytes.length + Number(terminated)
      legacyOffset += recordBytes + Number(terminated)
    }
  }

  async *reread(
    ranges: Iterable<ClaudeRange>
  ): AsyncGenerator<{ bytes: Buffer; start: number; ranges: ClaudeRange[] }> {
    let batch: ClaudeRange[] = []
    for (const range of ranges) {
      const high = batch[0]
      const low = batch.at(-1)
      if (
        high &&
        low &&
        (high.offset + high.length - range.offset > SLAB_BYTES ||
          low.offset - (range.offset + range.length) > 256)
      ) {
        yield await this.readRanges(batch)
        batch = []
      }
      batch.push(range)
    }
    if (batch.length) {
      yield await this.readRanges(batch)
    }
  }

  private async readRanges(ranges: ClaudeRange[]) {
    const start = ranges.at(-1)!.offset
    const first = ranges[0]
    const bytes = Buffer.allocUnsafeSlow(first.offset + first.length - start)
    await this.read(bytes, start)
    for (const range of ranges) {
      const localOffset = range.offset - start
      if (crc32(bytes.subarray(localOffset, localOffset + range.length)) !== range.digest) {
        changed()
      }
    }
    return { bytes, start, ranges }
  }

  async indexedVersion(): Promise<BigIntStats> {
    const descriptor = await this.file.stat({ bigint: true })
    const path = await stat(this.path, { bigint: true }).catch(changed)
    this.checkSize(descriptor)
    this.checkSize(path)
    if (!sameVersion(descriptor, path)) {
      changed()
    }
    return descriptor
  }

  async verify(): Promise<ClaudeSourceVersion> {
    this.signal?.throwIfAborted()
    const before = await this.indexedVersion()
    if (!this.checkpoint) {
      changed()
    }
    if (this.verified) {
      if (!sameVersion(before, this.verified)) {
        changed()
      }
    } else {
      const hash = createHash('sha256')
      const slab = Buffer.allocUnsafeSlow(Math.min(SLAB_BYTES, this.size))
      for (let offset = 0; offset < this.size; offset += slab.length) {
        const chunk = slab.subarray(0, Math.min(slab.length, this.size - offset))
        await this.read(chunk, offset)
        hash.update(chunk)
        if (!offset || offset % PROOF_STAT_BYTES === 0) {
          this.checkSize(await this.file.stat({ bigint: true }))
        }
      }
      const after = await this.indexedVersion()
      if (!sameVersion(before, after) || this.checkpoint.digest !== hash.digest('hex')) {
        changed()
      }
      this.verified = before
    }
    return {
      ...this.checkpoint,
      path: this.path,
      modified: before.mtimeNs,
      changed: before.ctimeNs
    }
  }

  private checkSize(current: BigIntStats): void {
    if (!sameFile(this.initial, current) || current.size < this.initial.size) {
      changed()
    }
    if (current.size > this.initial.size && this.checkpoint) {
      throw new ClaudeImportGrowthError({ prefix: this.checkpoint, minimumSize: current.size })
    }
  }

  private async readPrefix(visit: (buffer: Buffer, position: number) => void): Promise<void> {
    for (let offset = 0; offset < this.size; offset += SLAB_BYTES) {
      const slab = Buffer.allocUnsafeSlow(Math.min(SLAB_BYTES, this.size - offset))
      await this.read(slab, offset)
      visit(slab, offset)
    }
  }

  private async read(buffer: Buffer, position: number): Promise<void> {
    for (let offset = 0; offset < buffer.length;) {
      this.signal?.throwIfAborted()
      const { bytesRead } = await this.file.read(
        buffer,
        offset,
        buffer.length - offset,
        position + offset
      )
      if (!bytesRead) {
        changed()
      }
      offset += bytesRead
    }
  }
}

function checkRecordSize(bytes: number): void {
  if (bytes > RECORD_BYTES) {
    throw new ClaudeImportResourceError(
      `Session transcript record exceeds ${RECORD_BYTES} byte limit`
    )
  }
}

// Match the legacy framer's re-encoded offsets without decoding a hidden payload with invalid bytes.
function legacyUtf8Length(bytes: Buffer): number {
  let length = 0
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index++]
    if (lead < 128) {
      length++
      continue
    }
    if (lead < 194 || lead > 244) {
      length += 3
      continue
    }
    const width = lead < 224 ? 2 : lead < 240 ? 3 : 4
    let consumed = 1
    while (consumed < width && index < bytes.length) {
      const byte = bytes[index]
      if (
        byte < 128 ||
        byte > 191 ||
        (consumed === 1 &&
          ((lead === 224 && byte < 160) ||
            (lead === 237 && byte > 159) ||
            (lead === 240 && byte < 144) ||
            (lead === 244 && byte > 143)))
      ) {
        break
      }
      consumed++
      index++
    }
    length += consumed === width ? width : 3
  }
  return length
}
