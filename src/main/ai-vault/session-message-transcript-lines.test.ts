import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  iterateAiVaultTranscriptLines,
  type AiVaultTranscriptLine
} from './session-message-transcript-lines'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('iterateAiVaultTranscriptLines', () => {
  it('preserves CRLF byte offsets while streaming', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-vault-transcript-lines-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'session.jsonl')
    const first = '{"type":"user"}'
    const second = '{"type":"assistant"}'
    await writeFile(filePath, `${first}\r\n${second}\r\n`, 'utf-8')

    const lines: AiVaultTranscriptLine[] = []
    for await (const line of iterateAiVaultTranscriptLines(filePath)) {
      lines.push(line)
    }

    expect(lines).toEqual([
      { text: first, byteOffset: 0, lineNumber: 1 },
      { text: second, byteOffset: Buffer.byteLength(`${first}\r\n`, 'utf8'), lineNumber: 2 }
    ])
  })

  it('can stop after the first line without reading the rest as one buffer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-vault-transcript-lines-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'session.jsonl')
    await writeFile(filePath, 'first-line\nsecond-line\nthird-line\n', 'utf-8')

    const lines: string[] = []
    for await (const line of iterateAiVaultTranscriptLines(filePath)) {
      lines.push(line.text)
      if (lines.length === 1) {
        break
      }
    }

    expect(lines).toEqual(['first-line'])
  })

  it('strips a bare CR terminator at EOF', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-vault-transcript-lines-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'session.jsonl')
    const first = '{"type":"user"}'
    await writeFile(filePath, `${first}\r`, 'utf-8')

    const lines: AiVaultTranscriptLine[] = []
    for await (const line of iterateAiVaultTranscriptLines(filePath)) {
      lines.push(line)
    }

    expect(lines).toEqual([{ text: first, byteOffset: 0, lineNumber: 1 }])
  })
})
