import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_RESUMABLE_PREFIX_BYTES,
  jsonlPhysicalFileId,
  openJsonlFileReader,
  resolveJsonlFileCheckpoint,
  validateJsonlFileReader,
  type JsonlFileReader
} from './jsonl-file-checkpoint'
import { readJsonlLinesFromOffset, type JsonlLineAtOffset } from './jsonl-line-offsets'

let directory: string
let filePath: string
let reader: JsonlFileReader | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-jsonl-reader-'))
  filePath = join(directory, 'transcript.jsonl')
})

afterEach(async () => {
  await reader?.handle.close()
  reader = undefined
  await rm(directory, { recursive: true, force: true })
})

async function openFixture(content: string): Promise<JsonlFileReader> {
  await writeFile(filePath, content)
  reader = await openJsonlFileReader(filePath)
  return reader
}

async function collect(active: JsonlFileReader, start = 0): Promise<JsonlLineAtOffset[]> {
  const lines: JsonlLineAtOffset[] = []
  for await (const line of readJsonlLinesFromOffset(filePath, start, active)) {
    lines.push(line)
  }
  return lines
}

function positionalReadArgs(args: readonly unknown[]): [Buffer, number, number, number] {
  const [buffer, offset, length, position] = args
  if (
    !Buffer.isBuffer(buffer) ||
    typeof offset !== 'number' ||
    typeof length !== 'number' ||
    typeof position !== 'number'
  ) {
    throw new Error('Expected positional descriptor read arguments.')
  }
  return [buffer, offset, length, position]
}

describe('pinned small JSONL reader', () => {
  it('encodes large physical identifiers exactly and preserves numeric caller compatibility', () => {
    expect(jsonlPhysicalFileId({ dev: 1n, ino: 9_007_199_254_740_992n })).toBe('1:9007199254740992')
    expect(jsonlPhysicalFileId({ dev: 1n, ino: 9_007_199_254_740_993n })).toBe('1:9007199254740993')
    expect(jsonlPhysicalFileId({ dev: 3, ino: 4 })).toBe('3:4')
    expect(jsonlPhysicalFileId({ dev: 3, ino: 0 })).toBeNull()
    expect(jsonlPhysicalFileId({ dev: 3n, ino: 0n })).toBeNull()
  })

  it.each([Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid persisted offset %s before attempting a range read',
    async (parsedBytes) => {
      await expect(
        resolveJsonlFileCheckpoint(filePath, {
          parsedBytes,
          headDigest: '4096:invalid',
          boundaryDigest: '4096:invalid',
          physicalFileId: null
        })
      ).resolves.toBeNull()
    }
  )

  it('verifies an empty snapshot without creating a stream or issuing a read', async () => {
    const active = await openFixture('')
    const read = vi.spyOn(active.handle, 'read')
    const stream = vi.spyOn(active.handle, 'createReadStream')

    expect(await collect(active)).toEqual([])
    expect(await validateJsonlFileReader(active)).toBe(true)
    expect(stream).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('reads and verifies all bytes twice without creating a stream', async () => {
    const contents = '会🙂\r\n\r\nnext\n尾🙂'
    const active = await openFixture(contents)
    const read = vi.spyOn(active.handle, 'read')
    const stream = vi.spyOn(active.handle, 'createReadStream')

    expect(await collect(active)).toEqual([
      { line: '会🙂', endOffset: Buffer.byteLength('会🙂\r\n'), terminated: true },
      { line: '', endOffset: Buffer.byteLength('会🙂\r\n\r\n'), terminated: true },
      { line: 'next', endOffset: Buffer.byteLength('会🙂\r\n\r\nnext\n'), terminated: true },
      { line: '尾🙂', endOffset: Buffer.byteLength(contents), terminated: false }
    ])
    expect(await validateJsonlFileReader(active)).toBe(true)
    expect(stream).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(2)
    expect(
      (await Promise.all(read.mock.results.map((result) => result.value))).map(
        (result) => result.bytesRead
      )
    ).toEqual([Buffer.byteLength(contents), Buffer.byteLength(contents)])
  })

  it('accounts for a skipped legacy prefix in the full snapshot proof', async () => {
    const contents = 'legacy会\r\nnew🙂\r\n'
    const active = await openFixture(contents)
    const offset = Buffer.byteLength('legacy会\r\n')
    const read = vi.spyOn(active.handle, 'read')

    expect(await collect(active, offset)).toEqual([
      { line: 'new🙂', endOffset: Buffer.byteLength(contents), terminated: true }
    ])
    expect(await validateJsonlFileReader(active)).toBe(true)
    expect(active.streamBytes).toBe(Buffer.byteLength(contents) - offset)
    expect(active.snapshotBytes).toBe(Buffer.byteLength(contents))
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('accumulates short positional reads without exposing gaps or duplicate bytes', async () => {
    const contents = '会🙂\r\nnext\n終🙂'
    const active = await openFixture(contents)
    const read = active.handle.read.bind(active.handle)
    vi.spyOn(active.handle, 'read').mockImplementation(async (...args) => {
      const [buffer, offset, length, position] = positionalReadArgs(args)
      return read(buffer, offset, Math.min(length, 3), position)
    })

    expect(await collect(active)).toEqual([
      { line: '会🙂', endOffset: Buffer.byteLength('会🙂\r\n'), terminated: true },
      { line: 'next', endOffset: Buffer.byteLength('会🙂\r\nnext\n'), terminated: true },
      { line: '終🙂', endOffset: Buffer.byteLength(contents), terminated: false }
    ])
    expect(await validateJsonlFileReader(active)).toBe(true)
  })

  it('rejects a stable premature EOF instead of publishing partial history', async () => {
    const active = await openFixture('one\ntwo\n')
    const read = active.handle.read.bind(active.handle)
    vi.spyOn(active.handle, 'read').mockImplementationOnce(async (...args) => {
      const result = await read(...args)
      return { ...result, bytesRead: 0 }
    })

    await expect(collect(active)).rejects.toThrow(/snapshot read.*unchanged file boundary/)
    expect(active.streamBytes).toBe(0)
    expect(active.snapshotBytes).toBe(0)
  })

  it('rejects an unchanged EOF after a positive short read without yielding a partial line', async () => {
    const active = await openFixture('one\ntwo\n')
    const read = active.handle.read.bind(active.handle)
    vi.spyOn(active.handle, 'read')
      .mockImplementationOnce(async (...args) => {
        const [buffer, offset, length, position] = positionalReadArgs(args)
        return read(buffer, offset, Math.min(length, 2), position)
      })
      .mockImplementationOnce(async (...args) => {
        const result = await read(...args)
        return { ...result, bytesRead: 0 }
      })

    await expect(collect(active)).rejects.toThrow(/snapshot read.*unchanged file boundary/)
    expect(active.streamBytes).toBe(0)
    expect(active.snapshotBytes).toBe(0)
  })

  it('rejects a zero-byte verification read even after parsing every line', async () => {
    const active = await openFixture('one\ntwo\n')
    await collect(active)
    const read = active.handle.read.bind(active.handle)
    vi.spyOn(active.handle, 'read').mockImplementationOnce(async (...args) => {
      const result = await read(...args)
      return { ...result, bytesRead: 0 }
    })

    await expect(validateJsonlFileReader(active)).rejects.toThrow(
      /snapshot read.*unchanged file boundary/
    )
  })

  it('reads a skipped legacy prefix again when its proof changes during parsing', async () => {
    const active = await openFixture('old\nnext\n')
    await collect(active, 4)
    await writeFile(filePath, 'NEW\nnext\nappend\n')

    expect(await validateJsonlFileReader(active)).toBe(false)
  })

  it('leaves an append after the captured boundary for the next scan', async () => {
    const original = 'one会🙂\r\n'
    const active = await openFixture(original)
    await appendFile(filePath, 'two🙂\n')

    expect(await collect(active)).toEqual([
      { line: 'one会🙂', endOffset: Buffer.byteLength(original), terminated: true }
    ])
    expect(await validateJsonlFileReader(active)).toBe(true)
    expect(active.streamBytes).toBe(Buffer.byteLength(original))
  })

  it('rejects a full small-file middle rewrite even when the source also grows', async () => {
    const original = 'head\nold\ntail\n'
    const active = await openFixture(original)
    await collect(active)
    await writeFile(filePath, 'head\nNEW\ntail\nappend\n')

    expect(await validateJsonlFileReader(active)).toBe(false)
  })

  it('keeps the pinned handle but rejects path rotation', async () => {
    const original = 'one\n'
    const active = await openFixture(original)
    const replacement = join(directory, 'replacement.jsonl')
    await writeFile(replacement, 'two\n')
    await rename(filePath, join(directory, 'rotated.jsonl'))
    await rename(replacement, filePath)

    expect(await collect(active)).toEqual([{ line: 'one', endOffset: 4, terminated: true }])
    expect(await validateJsonlFileReader(active)).toBe(false)
  })

  it('invalidates a truncation encountered by the descriptor loop', async () => {
    const active = await openFixture('one\ntwo\n')
    await writeFile(filePath, 'one\n')

    expect(await collect(active)).toEqual([])
    expect(await validateJsonlFileReader(active)).toBe(false)
  })

  it('uses the bounded buffer at the crossover and streams larger snapshots', async () => {
    const active = await openFixture(`${'x'.repeat(MIN_RESUMABLE_PREFIX_BYTES - 1)}\n`)
    const stream = vi.spyOn(active.handle, 'createReadStream')
    await collect(active)
    expect(await validateJsonlFileReader(active)).toBe(true)
    expect(stream).not.toHaveBeenCalled()
    await active.handle.close()
    reader = undefined
    const large = await openFixture(`${'x'.repeat(MIN_RESUMABLE_PREFIX_BYTES)}\n`)
    const largeStream = vi.spyOn(large.handle, 'createReadStream')
    await collect(large)
    expect(await validateJsonlFileReader(large)).toBe(true)
    expect(largeStream).toHaveBeenCalledOnce()
  })
})
