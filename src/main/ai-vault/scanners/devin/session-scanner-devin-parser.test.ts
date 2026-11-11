import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDevinSessionFile } from './session-scanner-devin-parser'
import { withFullFirstUserPromptCapture } from '../../session-scanner-first-user-prompt-capture'
import type { TranscriptMessage } from '../../transcripts/session-transcript-consumers'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('parseDevinSessionFile', () => {
  it.each(
    [
      { payloadKind: 'string', fields: (text: string) => ({ message: text }) },
      { payloadKind: 'wrapped string', fields: (text: string) => ({ message: { content: text } }) },
      {
        payloadKind: 'wrapped blocks',
        fields: (text: string) => ({
          message: { content: text.split('\n').map((text) => ({ type: 'text', text })) }
        })
      },
      {
        payloadKind: 'array',
        fields: (text: string) => ({
          message: text.split('\n').map((text) => ({ type: 'text', text }))
        })
      },
      {
        payloadKind: 'content',
        fields: (text: string) => ({
          content: text.split('\n').map((text) => ({ type: 'text', text }))
        })
      },
      { payloadKind: 'text', fields: (text: string) => ({ text }) }
    ].flatMap((payloadKind) => [5000, 256 * 1024 + 1].map((length) => ({ ...payloadKind, length })))
  )(
    'preserves $length-character $payloadKind messages before display limits',
    async ({ fields, length }) => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-devin-content-'))
      tempDirs.push(dir)
      const path = join(dir, 'content.json')
      const text = `  first line\n${'x'.repeat(length)}\nlast line  `
      await writeFile(
        path,
        JSON.stringify({
          session_id: 'content',
          steps: ['user', 'agent'].map((source) => ({ source, ...fields(text) }))
        })
      )
      const messages: TranscriptMessage[] = []
      const session = await withFullFirstUserPromptCapture(() =>
        parseDevinSessionFile(
          { path, mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00.000Z' },
          'linux',
          { active: true, push: (message) => messages.push(message) }
        )
      )

      expect(messages).toEqual(
        ['user', 'assistant'].map((role) => ({
          role,
          text: text.slice(0, 256 * 1024),
          timestamp: null,
          ...(text.length > 256 * 1024 ? { textTruncated: true } : {})
        }))
      )
      expect(session?.firstUserPrompt).toBe(text.trim().slice(0, 256 * 1024))
      expect(session?.title).toHaveLength(96)
      expect(session?.previewMessages.map((message) => message.text.length)).toEqual([220, 220])
    }
  )
})
