import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function record(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text: id }] }
  })
}

async function fixture(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-tail-completed-to-'))
  tempRoots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, content)
  return filePath
}

function read(
  filePath: string,
  beforeOffset?: number
): ReturnType<typeof readNativeChatTranscriptTail> {
  return readNativeChatTranscriptTail({
    agent: 'claude',
    sessionId: 'session',
    filePath,
    limit: 40,
    ...(beforeOffset === undefined ? {} : { beforeOffset })
  })
}

describe('readNativeChatTranscriptTail completedTo', () => {
  it('reports the file end when the last record is complete', async () => {
    const content = `${record('a')}\n${record('b')}\n`
    const filePath = await fixture(content)

    const result = await read(filePath)

    expect(result).toMatchObject({ completedTo: content.length })
  })

  it('stops at the newline boundary while a record is still being written', async () => {
    const complete = `${record('a')}\n`
    const filePath = await fixture(`${complete}${record('b')}`)

    const result = await read(filePath)

    // The trailing record has no newline yet, so the cursor stops before it even
    // though this read happened to catch it whole. Resuming at the file end
    // would skip whatever the agent appends to that line, and re-reading it is
    // free: the client merges by message id.
    expect(result).toMatchObject({ completedTo: complete.length })
    expect('messages' in result && result.messages.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('does not decode a truncated record, and does not step over it', async () => {
    const complete = `${record('a')}\n`
    const filePath = await fixture(`${complete}{"type":"assistant","uuid":"b","mess`)

    const result = await read(filePath)

    expect(result).toMatchObject({ completedTo: complete.length })
    expect('messages' in result && result.messages.map((m) => m.id)).toEqual(['a'])
  })

  it('never reports past the range this read covered', async () => {
    const first = `${record('a')}\n`
    const filePath = await fixture(`${first}${record('b')}\n`)

    const result = await read(filePath, first.length)

    // A cursor derived from a separate stat would sit at the file end and skip
    // record `b`, which this read never returned.
    expect(result).toMatchObject({ completedTo: first.length })
  })

  it('reports 0 for an empty transcript', async () => {
    const filePath = await fixture('')

    await expect(read(filePath)).resolves.toMatchObject({ completedTo: 0 })
  })
})
