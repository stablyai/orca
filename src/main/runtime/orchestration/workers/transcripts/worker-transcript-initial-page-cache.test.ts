import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { readInitialLocalWorkerTranscriptPageReusing } from './worker-transcript-initial-page-cache'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const PROGRESS = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(98) })}\n`
const answer = (text: string) => `${JSON.stringify({ type: 'answer', text })}\n`

function countingDecoder() {
  const decoder = (line: string): NativeChatMessage | null => {
    decoder.lines++
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test writes only these two record shapes.
    const record = JSON.parse(line) as { type: string; text?: string }
    return record.type === 'answer'
      ? {
          id: record.text ?? '',
          role: 'assistant',
          blocks: [{ type: 'text', text: record.text ?? '' }],
          timestamp: null,
          source: 'transcript'
        }
      : null
  }
  decoder.lines = 0
  return decoder
}

it.each([1_000, 10_000])(
  'finds the latest answer behind %i progress records, then rereads nothing until the file changes',
  async (records) => {
    const directory = mkdtempSync(join(tmpdir(), 'transcript-initial-page-'))
    directories.push(directory)
    const filePath = join(directory, 'session.jsonl')
    writeFileSync(filePath, answer('latest answer') + PROGRESS.repeat(records))
    const decode = countingDecoder()

    const first = await readInitialLocalWorkerTranscriptPageReusing(filePath, 20, decode)
    const scanned = decode.lines
    const again = await Promise.all([
      readInitialLocalWorkerTranscriptPageReusing(filePath, 20, decode),
      readInitialLocalWorkerTranscriptPageReusing(filePath, 20, decode)
    ])

    expect(first).toMatchObject({ ok: true, messages: [{ id: 'latest answer' }] })
    expect(scanned).toBe(records + 1)
    expect(again.every((page) => page.ok && page.messages[0]?.id === 'latest answer')).toBe(true)
    expect(decode.lines).toBe(scanned)

    appendFileSync(filePath, answer('newer answer'))
    const changed = await readInitialLocalWorkerTranscriptPageReusing(filePath, 20, decode)
    expect(changed).toMatchObject({ ok: true })
    expect(changed.ok && changed.messages.map((message) => message.id)).toEqual([
      'latest answer',
      'newer answer'
    ])
  }
)
