import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consumeAiVaultJsonlLines, iterateAiVaultJsonlLines } from './session-jsonl-line-reader'

const tempDirs: string[] = []

async function tempFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-vault-jsonl-'))
  tempDirs.push(directory)
  const path = join(directory, 'session.jsonl')
  await writeFile(path, content)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('AI Vault bounded JSONL reader', () => {
  it('preserves complete UTF-8 and CRLF records plus a trailing partial line', async () => {
    const path = await tempFile('first🐋\r\nsecond\npartial')
    const lines: string[] = []

    const result = await consumeAiVaultJsonlLines({
      path,
      onLine: (line) => lines.push(line)
    })

    expect(lines).toEqual(['first🐋', 'second'])
    expect(result.trailingPartialLine).toBe('partial')
    expect(result.consumedThrough).toBe(Buffer.byteLength('first🐋\r\nsecond\n'))
    expect(result.bytesRead).toBe(Buffer.byteLength('first🐋\r\nsecond\npartial'))
  })

  it('drops only an oversized record and resumes at the next newline', async () => {
    const path = await tempFile(`keep\n${'x'.repeat(40)}\nafter\n`)
    const lines: string[] = []

    const result = await consumeAiVaultJsonlLines({
      path,
      maxRecordBytes: 8,
      onLine: (line) => lines.push(line)
    })

    expect(lines).toEqual(['keep', 'after'])
    expect(result.oversizedRecords).toBe(1)
    expect(result.consumedThrough).toBe(Buffer.byteLength(`keep\n${'x'.repeat(40)}\nafter\n`))
  })

  it('never materializes an oversized unterminated tail', async () => {
    const path = await tempFile(`keep\n${'x'.repeat(40)}`)
    const iterator = iterateAiVaultJsonlLines(path, { maxRecordBytes: 8 })
    const first = await iterator.next()
    const end = await iterator.next()

    expect(first).toMatchObject({ done: false, value: 'keep' })
    expect(end.done).toBe(true)
    expect(end.value).toMatchObject({
      trailingPartialLine: null,
      trailingPartialOversized: true
    })
  })

  it('yields an accepted unterminated tail for one-shot parsers', async () => {
    const path = await tempFile('complete\npartial')
    const lines: string[] = []

    for await (const line of iterateAiVaultJsonlLines(path)) {
      lines.push(line)
    }

    expect(lines).toEqual(['complete', 'partial'])
  })
})
