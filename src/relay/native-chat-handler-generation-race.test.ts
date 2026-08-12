import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as TailReaderModule from '../main/native-chat/transcript-tail-reader'

// `import type * as M` is a namespace; index it via `typeof M`, not `M[...]` (TS2709).
type ReadNativeChatTranscriptTail = (typeof TailReaderModule)['readNativeChatTranscriptTail']

const tailMocks = vi.hoisted(() => ({
  readNativeChatTranscriptTail: vi.fn(),
  realRead: null as null | ReadNativeChatTranscriptTail
}))

vi.mock('../main/native-chat/transcript-tail-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof TailReaderModule>()
  tailMocks.realRead = actual.readNativeChatTranscriptTail
  return {
    ...actual,
    readNativeChatTranscriptTail: (...args: Parameters<ReadNativeChatTranscriptTail>) =>
      tailMocks.readNativeChatTranscriptTail(...args)
  }
})

import { readRelayNativeChatTranscript } from './native-chat-handler'

let tempRoots: string[] = []

afterEach(async () => {
  tailMocks.readNativeChatTranscriptTail.mockReset()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

const SESSION_ID = '4f1f0f1e-0000-4000-8000-000000000099'

function assistantRecord(id: string, text: string): unknown {
  return {
    type: 'assistant',
    uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  }
}

describe('readRelayNativeChatTranscript generation race', () => {
  it('retries once when the file is replaced during the window read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-native-chat-gen-'))
    tempRoots.push(root)
    const transcriptPath = join(root, `${SESSION_ID}.jsonl`)
    const oldContent = `${JSON.stringify(assistantRecord('old-1', 'old'))}\n`
    const newContent = `${JSON.stringify(assistantRecord('new-1', 'new'))}\n`
    await writeFile(transcriptPath, oldContent)

    const realRead = tailMocks.realRead
    if (!realRead) {
      throw new Error('expected real tail reader to be captured')
    }
    let calls = 0
    tailMocks.readNativeChatTranscriptTail.mockImplementation(async (args, signal) => {
      calls += 1
      if (calls === 1) {
        const window = await realRead(args, signal)
        // Same byte length, different content + newer mtime: the post-read stamp
        // would otherwise publish old messages under the new generation.
        await writeFile(transcriptPath, newContent)
        const now = new Date(Date.now() + 5_000)
        await utimes(transcriptPath, now, now)
        return window
      }
      return realRead(args, signal)
    })

    const result = await readRelayNativeChatTranscript({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      limit: 40
    })

    expect(calls).toBe(2)
    expect(result).toMatchObject({ messages: [{ id: 'new-1' }] })
    expect('generation' in result && result.generation).toBeTruthy()
    // The published generation must match the live file, so the next poll can
    // answer unchanged against the replacement rather than the stale window.
    const live = await stat(transcriptPath)
    expect('generation' in result && result.generation?.endsWith(`:${live.mtimeMs}`)).toBe(true)
  })

  it('falls back to a retry-worthy miss if the file keeps flipping under the retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-native-chat-gen-flip-'))
    tempRoots.push(root)
    const transcriptPath = join(root, `${SESSION_ID}.jsonl`)
    await writeFile(transcriptPath, `${JSON.stringify(assistantRecord('a-1', 'a'))}\n`)

    const realRead = tailMocks.realRead
    if (!realRead) {
      throw new Error('expected real tail reader to be captured')
    }
    let flips = 0
    tailMocks.readNativeChatTranscriptTail.mockImplementation(async (args, signal) => {
      const window = await realRead(args, signal)
      flips += 1
      // Replace via rename so the inode (identity half of generation) flips every
      // time. A same-path rewrite can share an inode and, on coarse mtime clocks,
      // look unchanged to the post-read stamp.
      const next = join(root, `flip-${flips}.jsonl`)
      await writeFile(next, `${JSON.stringify(assistantRecord(`flip-${flips}`, 'flip'))}\n`)
      await rm(transcriptPath)
      const { rename } = await import('node:fs/promises')
      await rename(next, transcriptPath)
      return window
    })

    await expect(
      readRelayNativeChatTranscript({
        agent: 'claude',
        sessionId: SESSION_ID,
        transcriptPath,
        limit: 40
      })
    ).resolves.toEqual({ error: 'Transcript unavailable', notFound: true })
    expect(flips).toBeGreaterThanOrEqual(2)
  })
})
