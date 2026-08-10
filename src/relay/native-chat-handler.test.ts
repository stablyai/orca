import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SSH_NATIVE_CHAT_READ_LIMIT_MAX } from '../shared/ssh-native-chat-relay'
import {
  normalizeSshNativeChatRelayReadParams,
  readRelayNativeChatTranscript
} from './native-chat-handler'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

const SESSION_ID = '4f1f0f1e-0000-4000-8000-000000000001'

function assistantRecord(id: string, text: string): unknown {
  return {
    type: 'assistant',
    uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  }
}

async function writeTranscript(records: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-native-chat-'))
  tempRoots.push(root)
  const filePath = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return filePath
}

function read(
  transcriptPath: string,
  extra: {
    limit?: number
    knownFileSize?: number
    beforeOffset?: number
    generation?: string
  } = {}
): ReturnType<typeof readRelayNativeChatTranscript> {
  return readRelayNativeChatTranscript({
    agent: 'claude',
    sessionId: SESSION_ID,
    transcriptPath,
    limit: extra.limit ?? 40,
    ...(extra.knownFileSize === undefined ? {} : { knownFileSize: extra.knownFileSize }),
    ...(extra.beforeOffset === undefined ? {} : { beforeOffset: extra.beforeOffset }),
    ...(extra.generation === undefined ? {} : { generation: extra.generation })
  })
}

function cursorOf(result: Awaited<ReturnType<typeof readRelayNativeChatTranscript>>): {
  fileSize: number
  generation?: string
} {
  if ('error' in result) {
    throw new Error(`expected a read, got ${result.error}`)
  }
  return { fileSize: result.fileSize, generation: result.generation }
}

describe('readRelayNativeChatTranscript', () => {
  it('reads a transcript that only exists on this host', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'hello from the host')])

    const result = await read(transcriptPath)

    expect(result).toMatchObject({
      messages: [{ id: 'a-1', role: 'assistant' }],
      hasMore: false,
      filePath: transcriptPath
    })
    expect('fileSize' in result && result.fileSize).toBeGreaterThan(0)
  })

  it('answers unchanged from the stat alone when the poller already has this size', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'one')])
    const first = await read(transcriptPath)
    const fileSize = 'fileSize' in first ? first.fileSize : 0

    await expect(read(transcriptPath, { knownFileSize: fileSize })).resolves.toMatchObject({
      unchanged: true,
      fileSize
    })
  })

  it('ships only the new records once the agent appends, never the whole window again', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'one')])
    const first = await read(transcriptPath)
    const knownFileSize = 'fileSize' in first ? first.fileSize : 0
    await appendFile(transcriptPath, `${JSON.stringify(assistantRecord('a-2', 'two'))}\n`)

    const delta = await read(transcriptPath, { knownFileSize })

    expect(delta).toMatchObject({ appended: [{ id: 'a-2' }], filePath: transcriptPath })
    expect('appended' in delta && delta.appended).toHaveLength(1)
    expect('fileSize' in delta && delta.fileSize).toBeGreaterThan(knownFileSize)
  })

  it('leaves a half-written record for the next tick instead of decoding it', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'one')])
    const first = await read(transcriptPath)
    const knownFileSize = 'fileSize' in first ? first.fileSize : 0
    // No trailing newline: the agent is still writing this line.
    await appendFile(transcriptPath, JSON.stringify(assistantRecord('a-2', 'partial')))

    const delta = await read(transcriptPath, { knownFileSize })

    expect(delta).toMatchObject({ appended: [] })
    expect('fileSize' in delta && delta.fileSize).toBe(knownFileSize)
  })

  it('re-windows a transcript that shrank under the cursor, the way a rotation reads', async () => {
    const transcriptPath = await writeTranscript([
      assistantRecord('a-1', 'one'),
      assistantRecord('a-2', 'two')
    ])
    const first = await read(transcriptPath)
    const knownFileSize = 'fileSize' in first ? first.fileSize : 0
    await writeFile(transcriptPath, `${JSON.stringify(assistantRecord('b-1', 'fresh'))}\n`)

    const result = await read(transcriptPath, { knownFileSize })

    expect(result).toMatchObject({ messages: [{ id: 'b-1' }] })
  })

  it('never answers a pagination read from the cursor, whose file size does not move', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'one')])
    const first = await read(transcriptPath)
    const fileSize = 'fileSize' in first ? first.fileSize : 0

    const paged = await read(transcriptPath, { knownFileSize: fileSize, beforeOffset: fileSize })

    expect('unchanged' in paged).toBe(false)
    expect('appended' in paged).toBe(false)
  })

  it('stops the window cursor at the last complete record, so the next tick keeps it', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'one')])
    const completeEnd = (await stat(transcriptPath)).size
    // The agent is mid-write: this record has no newline yet.
    await appendFile(transcriptPath, JSON.stringify(assistantRecord('a-2', 'two')))

    const first = await read(transcriptPath)
    const cursor = cursorOf(first)
    expect(cursor.fileSize).toBe(completeEnd)

    // Finish the record; it must arrive whole rather than as a decoded fragment.
    await appendFile(transcriptPath, '\n')
    const delta = await read(transcriptPath, {
      knownFileSize: cursor.fileSize,
      generation: cursor.generation
    })

    expect(delta).toMatchObject({ appended: [{ id: 'a-2' }] })
  })

  it('re-windows a transcript replaced by one of the same length', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'one')])
    const first = await read(transcriptPath)
    const cursor = cursorOf(first)
    // Same byte length, different content: a size-only cursor would call this
    // unchanged and never show the replacement.
    await writeFile(transcriptPath, `${JSON.stringify(assistantRecord('a-1', 'ONE'))}\n`)
    expect((await stat(transcriptPath)).size).toBe(cursor.fileSize)
    const now = new Date(Date.now() + 5_000)
    await utimes(transcriptPath, now, now)

    const result = await read(transcriptPath, {
      knownFileSize: cursor.fileSize,
      generation: cursor.generation
    })

    expect('unchanged' in result).toBe(false)
    expect(result).toMatchObject({ messages: [{ id: 'a-1' }] })
  })

  it('still answers unchanged when the generation matches', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'one')])
    const cursor = cursorOf(await read(transcriptPath))

    await expect(
      read(transcriptPath, { knownFileSize: cursor.fileSize, generation: cursor.generation })
    ).resolves.toMatchObject({ unchanged: true })
  })

  it('stamps the generation after the read, so a concurrent append is not a false replacement', async () => {
    const transcriptPath = await writeTranscript([assistantRecord('a-1', 'one')])
    const first = await read(transcriptPath)
    const cursor = cursorOf(first)
    const stamped = (await stat(transcriptPath)).mtimeMs

    // The stamp must describe the state the caller actually received, so the
    // next poll can answer unchanged instead of re-windowing for nothing.
    expect(cursor.generation?.endsWith(`:${stamped}`)).toBe(true)
    await expect(
      read(transcriptPath, { knownFileSize: cursor.fileSize, generation: cursor.generation })
    ).resolves.toMatchObject({ unchanged: true })
  })

  it('reports an unresolvable transcript as a retry-worthy miss', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'orca-relay-native-chat-empty-'))
    tempRoots.push(emptyRoot)

    const result = await readRelayNativeChatTranscript(
      { agent: 'claude', sessionId: 'session-that-never-flushed', limit: 40 },
      { resolveOptions: { claudeProjectsDir: emptyRoot } }
    )

    expect(result).toEqual({ error: 'Transcript unavailable', notFound: true })
  })
})

describe('normalizeSshNativeChatRelayReadParams', () => {
  it('clamps the window and drops junk fields', () => {
    expect(
      normalizeSshNativeChatRelayReadParams({
        agent: ' claude ',
        sessionId: ' abc ',
        limit: 10_000,
        transcriptPath: 42,
        beforeOffset: -1,
        knownFileSize: 12
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'abc',
      limit: SSH_NATIVE_CHAT_READ_LIMIT_MAX,
      knownFileSize: 12
    })
  })

  it('falls back to a minimal window rather than an unbounded read', () => {
    expect(normalizeSshNativeChatRelayReadParams({ agent: 'claude', sessionId: 'a' })).toMatchObject(
      { limit: 1 }
    )
  })
})
