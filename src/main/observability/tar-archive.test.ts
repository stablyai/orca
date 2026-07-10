import { gunzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTarGzipArchive } from './tar-archive'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-tar-archive-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createTarGzipArchive', () => {
  it('round-trips small files through gzip-compressed ustar', async () => {
    const first = join(dir, 'first.txt')
    const second = join(dir, 'second.json')
    const archive = join(dir, 'bundle.tar.gz')
    writeFileSync(first, 'hello tar\n')
    writeFileSync(second, '{"ok":true}\n')

    await createTarGzipArchive(archive, [
      { name: 'first.txt', filePath: first },
      { name: 'nested/second.json', filePath: second }
    ])

    const entries = parseTarEntries(gunzipSync(readFileSync(archive)))
    expect(entries).toEqual([
      { name: 'first.txt', content: 'hello tar\n' },
      { name: 'nested/second.json', content: '{"ok":true}\n' }
    ])
  })
})

function parseTarEntries(buffer: Buffer): { name: string; content: string }[] {
  const entries: { name: string; content: string }[] = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      break
    }
    const name = trimAtNull(header.toString('utf8', 0, 100))
    const sizeText = trimAtNull(header.toString('ascii', 124, 136)).trim()
    const size = Number.parseInt(sizeText, 8)
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    entries.push({
      name,
      content: buffer.toString('utf8', contentStart, contentEnd)
    })
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function trimAtNull(value: string): string {
  const index = value.indexOf('\u0000')
  return index === -1 ? value : value.slice(0, index)
}
