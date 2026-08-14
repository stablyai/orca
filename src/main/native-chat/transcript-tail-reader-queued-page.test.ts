import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const AT = (seconds: number): string => `2026-06-01T10:00:${String(seconds).padStart(2, '0')}.000Z`

function turn(uuid: string, role: 'user' | 'assistant', text: string, seconds: number): string {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: AT(seconds),
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }
  })}\n`
}

function queuedPrompt(uuid: string, text: string, enqueuedAt: number): string {
  return `${JSON.stringify({
    type: 'attachment',
    uuid,
    timestamp: AT(enqueuedAt),
    attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt' }
  })}\n`
}

async function transcript(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-tail-queued-page-'))
  roots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, body)
  return filePath
}

describe('queued prompts at a pagination boundary', () => {
  // Why: the predecessor a queued prompt anchors to can fall outside the window,
  // so anchoring has to happen before the page is sliced.
  it('anchors a queued prompt that opens the page against a predecessor outside it', async () => {
    const filePath = await transcript(
      turn('u1', 'user', 'first prompt', 0) +
        turn('a1', 'assistant', 'reply to first', 30) +
        queuedPrompt('q1', 'queued while busy', 10) +
        turn('a2', 'assistant', 'final reply', 60)
    )

    // A window of 2 starts at the queued record, leaving its predecessor behind.
    const page = await readNativeChatTranscriptTailFile(filePath, 2, decodeClaudeTranscriptLine)

    expect(page.messages.map((message) => message.id)).toEqual(['q1', 'a2'])
    const queued = page.messages[0]
    expect(queued?.timestamp).toBe(Date.parse(AT(30)) + 1)
    expect(queued?.timestamp).not.toBe(Date.parse(AT(10)))
  })

  it('keeps the full read anchored too', async () => {
    const filePath = await transcript(
      turn('u1', 'user', 'first prompt', 0) +
        turn('a1', 'assistant', 'reply to first', 30) +
        queuedPrompt('q1', 'queued while busy', 10)
    )

    const page = await readNativeChatTranscriptTailFile(filePath, 50, decodeClaudeTranscriptLine)

    expect(page.messages.map((message) => message.timestamp)).toEqual([
      Date.parse(AT(0)),
      Date.parse(AT(30)),
      Date.parse(AT(30)) + 1
    ])
  })
})
