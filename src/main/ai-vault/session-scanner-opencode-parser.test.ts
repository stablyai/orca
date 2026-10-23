import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeOpenCodeMessages,
  parseOpenCodeSessionFile
} from './session-scanner-opencode-parser'
import { createAccumulator } from './session-scanner-accumulator'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import type { TranscriptMessage } from './session-transcript-consumers'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function userMessage(text: string, createdAt: number): string {
  return JSON.stringify({
    role: 'user',
    content: [{ type: 'text', text }],
    time: { created: createdAt },
    tokens: { input: 5, output: 0 }
  })
}

describe('parseOpenCodeSessionFile', () => {
  it.each(
    [undefined, null, [], '', '   ', [{ type: 'image', source: {} }]].map((content) => ({
      content
    }))
  )(
    'shows a summary for empty content $content without publishing or copying it',
    async ({ content }) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'orca-opencode-summary-'))
      tempDirs.push(storageRoot)
      const messageDir = join(storageRoot, 'message', 'ses_summary')
      await mkdir(messageDir, { recursive: true })
      await writeFile(
        join(messageDir, 'msg_1.json'),
        JSON.stringify({
          role: 'user',
          content,
          summary: { title: 'Generated title', body: 'Generated summary' },
          time: { created: 1_777_634_000_000 }
        })
      )
      const messages: TranscriptMessage[] = []
      const accumulator = createAccumulator({
        agent: 'opencode',
        sessionId: 'ses_summary',
        file: {
          path: join(storageRoot, 'session.json'),
          mtimeMs: 1,
          modifiedAt: '2026-05-01T00:00:00.000Z'
        },
        messages: { active: true, push: (message) => messages.push(message) }
      })
      await withFullFirstUserPromptCapture(() =>
        consumeOpenCodeMessages(accumulator, storageRoot, 'ses_summary')
      )
      expect(accumulator.previewMessages.map((message) => message.text)).toEqual([
        'Generated summary'
      ])
      expect(messages).toEqual([])
      expect(accumulator.firstUserPrompt).toBeNull()
    }
  )

  it.each([5000, 256 * 1024 + 1])(
    'publishes %i-character legacy OpenCode content before preview limits',
    async (length) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'orca-opencode-transcript-'))
      tempDirs.push(storageRoot)
      const sessionDir = join(storageRoot, 'session', 'project')
      const messageDir = join(storageRoot, 'message', 'ses_transcript')
      await mkdir(sessionDir, { recursive: true })
      await mkdir(messageDir, { recursive: true })
      const path = join(sessionDir, 'ses_transcript.json')
      await writeFile(path, JSON.stringify({ id: 'ses_transcript' }))
      const text = 'x'.repeat(length)
      await writeFile(join(messageDir, 'msg_1.json'), userMessage(text, 1_777_634_000_000))
      const messages: TranscriptMessage[] = []
      const session = await parseOpenCodeSessionFile(
        { path, mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00.000Z' },
        'linux',
        { active: true, push: (message) => messages.push(message) }
      )
      expect(messages).toEqual([
        {
          role: 'user',
          text: text.slice(0, 256 * 1024),
          timestamp: '2026-05-01T11:13:20.000Z',
          ...(length > 256 * 1024 ? { textTruncated: true } : {})
        }
      ])
      expect(session?.previewMessages[0]?.text).toHaveLength(220)
    }
  )

  it('skips a corrupt message file instead of discarding the whole session', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'orca-opencode-parser-'))
    tempDirs.push(storageRoot)
    const sessionDir = join(storageRoot, 'session', 'project')
    const messageDir = join(storageRoot, 'message', 'ses_corrupt')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(messageDir, { recursive: true })

    const path = join(sessionDir, 'ses_corrupt.json')
    const mtimeMs = Date.now()
    await writeFile(
      path,
      JSON.stringify({
        id: 'ses_corrupt',
        directory: '/tmp/opencode',
        title: 'OpenCode title',
        time: { created: 1_777_634_000_000, updated: 1_777_634_002_000 }
      })
    )
    await writeFile(join(messageDir, 'msg_1.json'), userMessage('First prompt', 1_777_634_000_000))
    // Partially-written file from a live OpenCode process.
    await writeFile(join(messageDir, 'msg_2.json'), '{"role":"user","content":[{"type":')
    await writeFile(join(messageDir, 'msg_3.json'), userMessage('Third prompt', 1_777_634_002_000))

    const session = await parseOpenCodeSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })

    expect(session).not.toBeNull()
    expect(session?.messageCount).toBe(2)
    expect(session?.totalTokens).toBe(10)
    expect(session?.previewMessages.map((message) => message.text)).toEqual([
      'First prompt',
      'Third prompt'
    ])
  })

  it('orders messages by created time when file order disagrees', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'orca-opencode-parser-'))
    tempDirs.push(storageRoot)
    const sessionDir = join(storageRoot, 'session', 'project')
    const messageDir = join(storageRoot, 'message', 'ses_order')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(messageDir, { recursive: true })

    const path = join(sessionDir, 'ses_order.json')
    const mtimeMs = Date.now()
    await writeFile(path, JSON.stringify({ id: 'ses_order', directory: '/tmp/opencode' }))
    // File names sort the opposite way from the transcript's creation order.
    await writeFile(join(messageDir, 'msg_a.json'), userMessage('Later turn', 1_777_634_002_000))
    await writeFile(join(messageDir, 'msg_b.json'), userMessage('Earliest turn', 1_777_634_000_000))

    const session = await withFullFirstUserPromptCapture(() =>
      parseOpenCodeSessionFile({
        path,
        mtimeMs,
        modifiedAt: new Date(mtimeMs).toISOString()
      })
    )

    expect(session?.firstUserPrompt).toBe('Earliest turn')
    expect(session?.previewMessages.map((message) => message.text)).toEqual([
      'Earliest turn',
      'Later turn'
    ])
  })
})
