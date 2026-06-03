import { closeSync, openSync, writeSync } from 'fs'
import type { StatsFile } from './types'

const UTF8_WRITE_BUFFER_BYTES = 16 * 1024
const REPLACEMENT_CHARACTER = 0xfffd
const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff
const LOW_SURROGATE_START = 0xdc00
const LOW_SURROGATE_END = 0xdfff

export function writeStatsJsonFileSync(filePath: string, data: StatsFile): void {
  const json = JSON.stringify(data)
  writeUtf8StringFileSync(filePath, json)
}

function writeUtf8StringFileSync(filePath: string, value: string): void {
  const fd = openSync(filePath, 'w')
  try {
    writeUtf8StringToFdSync(fd, value)
  } finally {
    closeSync(fd)
  }
}

function writeUtf8StringToFdSync(fd: number, value: string): void {
  const buffer = new Uint8Array(UTF8_WRITE_BUFFER_BYTES)
  let bufferOffset = 0

  const flush = (): void => {
    if (bufferOffset === 0) {
      return
    }
    writeAllSync(fd, buffer.subarray(0, bufferOffset))
    bufferOffset = 0
  }

  const reserve = (byteCount: number): void => {
    if (bufferOffset + byteCount > buffer.length) {
      flush()
    }
  }

  // Why not writeFileSync(file, json, 'utf-8'): Electron 42.3.x can abort
  // while converting sparse non-ASCII strings through Node's bulk UTF-8 path.
  for (let index = 0; index < value.length; index++) {
    const firstCodeUnit = value.charCodeAt(index)

    if (firstCodeUnit < 0x80) {
      reserve(1)
      buffer[bufferOffset++] = firstCodeUnit
      continue
    }

    if (firstCodeUnit < 0x800) {
      reserve(2)
      buffer[bufferOffset++] = 0xc0 | (firstCodeUnit >> 6)
      buffer[bufferOffset++] = 0x80 | (firstCodeUnit & 0x3f)
      continue
    }

    if (firstCodeUnit >= HIGH_SURROGATE_START && firstCodeUnit <= HIGH_SURROGATE_END) {
      const secondCodeUnit = value.charCodeAt(index + 1)
      if (secondCodeUnit >= LOW_SURROGATE_START && secondCodeUnit <= LOW_SURROGATE_END) {
        const codePoint =
          0x10000 +
          ((firstCodeUnit - HIGH_SURROGATE_START) << 10) +
          (secondCodeUnit - LOW_SURROGATE_START)
        index++
        reserve(4)
        buffer[bufferOffset++] = 0xf0 | (codePoint >> 18)
        buffer[bufferOffset++] = 0x80 | ((codePoint >> 12) & 0x3f)
        buffer[bufferOffset++] = 0x80 | ((codePoint >> 6) & 0x3f)
        buffer[bufferOffset++] = 0x80 | (codePoint & 0x3f)
        continue
      }
      writeThreeByteCodePoint(REPLACEMENT_CHARACTER)
      continue
    }

    if (firstCodeUnit >= LOW_SURROGATE_START && firstCodeUnit <= LOW_SURROGATE_END) {
      writeThreeByteCodePoint(REPLACEMENT_CHARACTER)
      continue
    }

    writeThreeByteCodePoint(firstCodeUnit)
  }

  flush()

  function writeThreeByteCodePoint(codePoint: number): void {
    reserve(3)
    buffer[bufferOffset++] = 0xe0 | (codePoint >> 12)
    buffer[bufferOffset++] = 0x80 | ((codePoint >> 6) & 0x3f)
    buffer[bufferOffset++] = 0x80 | (codePoint & 0x3f)
  }
}

function writeAllSync(fd: number, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) {
      throw new Error('Failed to write stats JSON')
    }
    offset += written
  }
}
