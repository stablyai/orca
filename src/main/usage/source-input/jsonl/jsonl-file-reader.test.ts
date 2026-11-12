import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openJsonlFileReader,
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
})
