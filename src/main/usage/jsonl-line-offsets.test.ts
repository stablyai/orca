import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonlLinesFromOffset, type JsonlLineAtOffset } from './jsonl-line-offsets'

let workDir: string

async function collect(filePath: string, startOffset = 0): Promise<JsonlLineAtOffset[]> {
  const lines: JsonlLineAtOffset[] = []
  for await (const entry of readJsonlLinesFromOffset(filePath, startOffset)) {
    lines.push(entry)
  }
  return lines
}

function writeFixture(name: string, contents: string): string {
  const filePath = join(workDir, name)
  writeFileSync(filePath, contents, 'utf-8')
  return filePath
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'orca-jsonl-offsets-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('readJsonlLinesFromOffset', () => {
  it('reports byte offsets past each newline', async () => {
    const filePath = writeFixture('lf.jsonl', 'ab\ncde\n')

    expect(await collect(filePath)).toEqual([
      { line: 'ab', endOffset: 3, terminated: true },
      { line: 'cde', endOffset: 7, terminated: true }
    ])
  })

  it('strips the carriage return but counts it in the offset', async () => {
    const filePath = writeFixture('crlf.jsonl', 'ab\r\ncde\r\n')

    expect(await collect(filePath)).toEqual([
      { line: 'ab', endOffset: 4, terminated: true },
      { line: 'cde', endOffset: 9, terminated: true }
    ])
  })

  it('flags a trailing line with no newline', async () => {
    const filePath = writeFixture('partial.jsonl', 'ab\ncd')

    expect(await collect(filePath)).toEqual([
      { line: 'ab', endOffset: 3, terminated: true },
      { line: 'cd', endOffset: 5, terminated: false }
    ])
  })

  it('counts multibyte characters as bytes, not code points', async () => {
    const filePath = writeFixture('utf8.jsonl', '"héllo→"\n"next"\n')
    const firstLineBytes = Buffer.byteLength('"héllo→"\n', 'utf-8')

    const lines = await collect(filePath)

    expect(lines[0]).toEqual({ line: '"héllo→"', endOffset: firstLineBytes, terminated: true })
    expect(lines[1]?.endOffset).toBe(statSync(filePath).size)
  })

  it('resumes from a mid-file offset', async () => {
    const filePath = writeFixture('resume.jsonl', 'one\ntwo\nthree\n')

    expect(await collect(filePath, 4)).toEqual([
      { line: 'two', endOffset: 8, terminated: true },
      { line: 'three', endOffset: 14, terminated: true }
    ])
  })

  it('yields nothing when the offset is already at the end', async () => {
    const filePath = writeFixture('end.jsonl', 'one\n')

    expect(await collect(filePath, 4)).toEqual([])
  })
})
