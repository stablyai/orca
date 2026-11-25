import { createHash } from 'node:crypto'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { crc32 } from 'node:zlib'
import { MAX_LEGACY_IMPORT_RECORD_BYTES as RECORD_BYTES } from './journal-legacy-transcript-stream'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'

const SLAB_BYTES = 512 * 1024
const MAX_PROOF_ATTEMPTS = 3

function changed(): never {
  throw new ClaudeImportResourceError('Claude transcript changed during history import.')
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
}

function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

export type ClaudeSourceVersion = {
  path: string
  size: bigint
  device: bigint
  inode: bigint
  modified: bigint
  changed: bigint
}

export type ClaudeRange = {
  offset: number
  legacyOffset: number
  line: number
  length: number
  digest: number
}

export class ClaudeImportSource {
  private readonly size: number
  private digest: Buffer | undefined
  private terminatedLine = true
  private verified: BigIntStats | undefined

  private constructor(
    private readonly file: FileHandle,
    private readonly path: string,
    private readonly signal: AbortSignal | undefined,
    initial: BigIntStats
  ) {
    this.size = Number(initial.size)
    if (!Number.isSafeInteger(this.size)) {
      changed()
    }
  }

  static async open(path: string, signal?: AbortSignal): Promise<ClaudeImportSource> {
    const before = await stat(path, { bigint: true })
    if (!before.isFile()) {
      changed()
    }
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
    const file = await open(path, flags)
    try {
      const initial = await file.stat({ bigint: true })
      if (!sameFile(before, initial)) {
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

  async scan(onLine: (bytes: Buffer, range: ClaudeRange) => void): Promise<void> {
    let offset = 0
    let legacyOffset = 0
    let line = 0
    let pending: Buffer[] = []
    let pendingBytes = 0
    const hash = createHash('sha256')
    await this.readPrefix((slab) => {
      hash.update(slab)
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
    this.terminatedLine = pendingBytes === 0
    if (pendingBytes) {
      emit(Buffer.concat(pending, pendingBytes), false)
    }
    this.digest = hash.digest()

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

  async verify(refresh = false): Promise<ClaudeSourceVersion> {
    for (let attempt = 0; attempt < MAX_PROOF_ATTEMPTS; attempt++) {
      this.signal?.throwIfAborted()
      const before = await this.version()
      if (!before) {
        continue
      }
      // A matching stat can reuse a completed content proof on this handle.
      if (refresh || !this.verified || !sameVersion(before, this.verified)) {
        const matches = await this.verifyPrefix(before)
        const after = await this.version()
        if (!after || !sameVersion(before, after)) {
          continue
        }
        if (!matches) {
          changed()
        }
        this.verified = before
      }
      return {
        path: this.path,
        size: before.size,
        device: before.dev,
        inode: before.ino,
        modified: before.mtimeNs,
        changed: before.ctimeNs
      }
    }
    changed()
  }

  private async verifyPrefix(before: BigIntStats): Promise<boolean> {
    if (!this.terminatedLine && before.size > this.size) {
      const delimiter = Buffer.allocUnsafe(1)
      await this.read(delimiter, this.size)
      if (delimiter[0] !== 10) {
        return false
      }
    }
    const hash = createHash('sha256')
    const slab = Buffer.allocUnsafeSlow(Math.min(SLAB_BYTES, this.size))
    for (let offset = 0; offset < this.size; offset += slab.length) {
      const chunk = slab.subarray(0, Math.min(slab.length, this.size - offset))
      await this.read(chunk, offset)
      hash.update(chunk)
    }
    return this.digest?.equals(hash.digest()) ?? false
  }

  private async version(): Promise<BigIntStats | undefined> {
    const descriptor = await this.file.stat({ bigint: true })
    const path = await stat(this.path, { bigint: true }).catch(changed)
    if (!sameFile(descriptor, path) || descriptor.size < this.size || path.size < this.size) {
      changed()
    }
    return sameVersion(descriptor, path) ? descriptor : undefined
  }

  private async readPrefix(visit: (buffer: Buffer) => void): Promise<void> {
    for (let offset = 0; offset < this.size; offset += SLAB_BYTES) {
      const slab = Buffer.allocUnsafeSlow(Math.min(SLAB_BYTES, this.size - offset))
      await this.read(slab, offset)
      visit(slab)
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
