import { open } from 'node:fs/promises'
import path from 'node:path'
const { lookup }: { lookup: (path: string) => string | false } = require('mime-types')

export async function readTaskFile(file: string, directory: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const filename = path.resolve(directory, file)
  const handle = await open(filename, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 10 * 1024 * 1024) {
      throw new Error('OpenCode attachment must be a regular file no larger than 10 MiB')
    }
    const content = Buffer.alloc(info.size)
    let offset = 0
    while (offset < content.length) {
      signal.throwIfAborted()
      const read = await handle.read(content, offset, content.length - offset, offset)
      if (read.bytesRead === 0) {
        break
      }
      offset += read.bytesRead
    }
    return { filename, bytes: content.subarray(0, offset) }
  } finally {
    await handle.close()
  }
}

export async function prepareV2File(file: string, directory: string, signal: AbortSignal) {
  const { filename, bytes } = await readTaskFile(file, directory, signal)
  const detected = lookup(filename) || 'application/octet-stream'
  const name = path.basename(filename)
  if (detected.startsWith('image/') || detected === 'application/pdf') {
    return { attachment: { name, uri: `data:${detected};base64,${bytes.toString('base64')}` } }
  }
  const text = bytes.toString('utf8')
  const binary =
    bytes.includes(0) ||
    (bytes.length > 0 &&
      bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0) /
        bytes.length >
        0.3)
  const mime = !binary && Buffer.from(text, 'utf8').equals(bytes) ? 'text/plain' : detected
  return mime === 'text/plain'
    ? { text: `<file name="${name}">\n${text}\n</file>` }
    : { attachment: { name, uri: `data:${mime};base64,${bytes.toString('base64')}` } }
}

export async function prepareV1File(file: string, directory: string, signal: AbortSignal) {
  const { filename, bytes } = await readTaskFile(file, directory, signal)
  const text = bytes.toString('utf8')
  const mime = Buffer.from(text, 'utf8').equals(bytes)
    ? 'text/plain'
    : lookup(filename) || 'application/octet-stream'
  return {
    type: 'file' as const,
    mime,
    filename: path.basename(filename),
    url: `data:${mime};base64,${bytes.toString('base64')}`
  }
}
