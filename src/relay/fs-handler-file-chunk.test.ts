import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELAY_FILE_CHUNK_MAX_BYTES, readRelayFileChunk } from './fs-handler-file-chunk'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('relay file chunk reads', () => {
  it('returns exact bounded ranges and EOF without text decoding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-file-chunk-'))
    roots.push(root)
    const filePath = join(root, 'data.bin')
    await writeFile(filePath, Buffer.from([0, 1, 2, 3, 255]))

    await expect(readRelayFileChunk({ filePath, offset: 2, length: 2 })).resolves.toEqual({
      contentBase64: Buffer.from([2, 3]).toString('base64'),
      bytesRead: 2,
      eof: false
    })
    await expect(readRelayFileChunk({ filePath, offset: 4, length: 4 })).resolves.toEqual({
      contentBase64: Buffer.from([255]).toString('base64'),
      bytesRead: 1,
      eof: true
    })
  })

  it('rejects invalid ranges and directories before allocating a chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-file-chunk-'))
    roots.push(root)
    const directory = join(root, 'dir')
    await mkdir(directory)

    await expect(readRelayFileChunk({ filePath: directory, offset: 0, length: 1 })).rejects.toThrow(
      'directory'
    )
    await expect(
      readRelayFileChunk({
        filePath: directory,
        offset: 0,
        length: RELAY_FILE_CHUNK_MAX_BYTES + 1
      })
    ).rejects.toThrow('invalid_file_chunk_range')
  })
})
