import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages
} from './transcript-incremental-reader'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTail,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

const decodeClaude = nativeChatLineDecoderForAgent('claude')!

function userRecord(id: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid: id, message: { role: 'user', content: text } })
}

function assistantRecord(id: string, content: unknown[]): string {
  return JSON.stringify({ type: 'assistant', uuid: id, message: { role: 'assistant', content } })
}

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-row-offset-'))
  tempRoots.push(root)
  return join(root, 'transcript.jsonl')
}

/** Byte offset of each line's first byte, as written. */
function lineOffsets(lines: readonly string[], separator: string): number[] {
  let offset = 0
  return lines.map((line) => {
    const start = offset
    offset += Buffer.byteLength(line + separator)
    return start
  })
}

function offsetsById(messages: readonly NativeChatMessage[]): Record<string, number | undefined> {
  return Object.fromEntries(messages.map((message) => [message.id, message.transcriptOffset]))
}

describe('transcript row offsets', () => {
  it('stamps each record byte offset, starting at 0, across multibyte UTF-8', async () => {
    const lines = [
      userRecord('u-1', '日本語のテキスト 🎉'),
      assistantRecord('a-1', [{ type: 'text', text: 'ünïcödé reply' }]),
      userRecord('u-2', 'ascii')
    ]
    const filePath = await fixturePath()
    await writeFile(filePath, `${lines.join('\n')}\n`)
    const expected = lineOffsets(lines, '\n')

    const page = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaude)

    expect(offsetsById(page.messages)).toEqual({
      'u-1': 0,
      'a-1': expected[1],
      'u-2': expected[2]
    })
    expect(expected[1]).toBeGreaterThan(lines[0].length)
  })

  it('counts the CR of CRLF records in the next record offset', async () => {
    const lines = [userRecord('u-1', 'one'), userRecord('u-2', 'two'), userRecord('u-3', 'three')]
    const filePath = await fixturePath()
    await writeFile(filePath, `${lines.join('\r\n')}\r\n`)
    const expected = lineOffsets(lines, '\r\n')

    const page = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaude)

    expect(page.messages.map((message) => message.transcriptOffset)).toEqual(expected)
  })

  it('keeps one offset for reasoning and answer decoded from the same record', async () => {
    const lines = [
      userRecord('u-1', 'question'),
      assistantRecord('a-1', [
        { type: 'thinking', thinking: 'pondering' },
        { type: 'text', text: 'answer' }
      ])
    ]
    const filePath = await fixturePath()
    await writeFile(filePath, `${lines.join('\n')}\n`)

    const page = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaude)

    const fromRecord = page.messages.filter((message) => message.id.startsWith('a-1'))
    expect(fromRecord.length).toBeGreaterThan(0)
    expect(new Set(fromRecord.map((message) => message.transcriptOffset))).toEqual(
      new Set([lineOffsets(lines, '\n')[1]])
    )
  })

  it('keeps neighbour offsets exact around a skipped oversized record', async () => {
    const huge = userRecord('u-huge', 'x'.repeat(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES))
    const lines = [userRecord('u-1', 'before'), huge, userRecord('u-2', 'after')]
    const filePath = await fixturePath()
    await writeFile(filePath, `${lines.join('\n')}\n`)
    const expected = lineOffsets(lines, '\n')

    const page = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaude)

    expect(offsetsById(page.messages)).toEqual({ 'u-1': 0, 'u-2': expected[2] })
  })

  it('gives a record the same offset from the tail, the incremental append, and a replacement after truncation', async () => {
    const first = [userRecord('u-1', 'héllo'), userRecord('u-2', 'wörld')]
    const appended = [assistantRecord('a-3', [{ type: 'text', text: '返事' }])]
    const partial = userRecord('u-4', 'partial')
    const filePath = await fixturePath()
    // A partial final line is not part of the initial tail; the incremental read owns it.
    await writeFile(filePath, `${first.join('\n')}\n${partial.slice(0, 10)}`)
    const all = [...first, ...appended]

    const initial = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaude)
    expect(initial.messages.map((message) => message.id)).toEqual(['u-1', 'u-2'])
    const state = createIncrementalTranscriptState()
    state.offset = initial.consumedTo
    state.pendingStart = initial.consumedTo

    await writeFile(filePath, `${all.join('\n')}\n`)
    const incremental = await readIncrementalTranscriptMessages(filePath, state, decodeClaude)
    const fullTail = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaude)

    expect(incremental.map((message) => message.id)).toEqual(['a-3'])
    expect(incremental[0].transcriptOffset).toBe(lineOffsets(all, '\n')[2])
    expect(offsetsById(fullTail.messages)).toEqual({
      ...offsetsById(initial.messages),
      ...offsetsById(incremental)
    })

    // Truncate to the first record, then rewrite: the replacement snapshot re-derives the same offsets.
    await writeFile(filePath, `${first[0]}\n`)
    const truncated = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaude)
    expect(offsetsById(truncated.messages)).toEqual({ 'u-1': 0 })
    await appendFile(filePath, `${first[1]}\n${appended[0]}\n`)
    const replacement = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaude)
    expect(offsetsById(replacement.messages)).toEqual(offsetsById(fullTail.messages))
  })

  it('pages older history with beforeOffset onto the same row offsets', async () => {
    const lines = Array.from({ length: 6 }, (_, index) => userRecord(`u-${index}`, `m${index}`))
    const filePath = await fixturePath()
    await writeFile(filePath, `${lines.join('\n')}\n`)
    const expected = lineOffsets(lines, '\n')

    const newest = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 's',
      filePath,
      limit: 3
    })
    if (!('messages' in newest)) {
      throw new Error(newest.error)
    }
    expect(newest.beforeOffset).toBe(newest.messages[0].transcriptOffset)
    const older = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 's',
      filePath,
      limit: 3,
      beforeOffset: newest.beforeOffset
    })
    if (!('messages' in older)) {
      throw new Error(older.error)
    }

    expect([...older.messages, ...newest.messages].map((m) => m.transcriptOffset)).toEqual(expected)
  })
})
