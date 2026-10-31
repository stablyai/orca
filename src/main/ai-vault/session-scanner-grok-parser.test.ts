import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import { parseGrokSessionFile } from './session-scanner-grok-parser'
import type { TranscriptMessage } from './session-transcript-consumers'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('AI Vault Grok session parser', () => {
  it.each([false, true])(
    'bounds preview scanning while preserving full turns with capture %s',
    async (active) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-grok-preview-budget-'))
      tempRoots.push(root)
      const path = join(root, 'summary.json')
      await writeFile(path, JSON.stringify({ info: { id: 'grok-preview-budget' } }))
      const hidden = `<system-reminder>${'x'.repeat(4057)}</system-reminder>`
      const text = `${hidden}ask😀tail`
      const userText = `ask${' '.repeat(4093)}tail`
      const turns = [
        { type: 'user', content: `<user_query>${userText}</user_query>` },
        { type: 'assistant', content: text },
        {
          type: 'assistant',
          content: [
            { type: 'text', text: ' '.repeat(2048) },
            { type: 'text', text: `${' '.repeat(2048)}outside preview budget` }
          ]
        }
      ]
      await writeFile(
        join(root, 'chat_history.jsonl'),
        turns.map((turn) => JSON.stringify(turn)).join('\n')
      )
      const messages: TranscriptMessage[] = []
      const session = await withFullFirstUserPromptCapture(() =>
        parseGrokSessionFile(
          { path, mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00.000Z' },
          'linux',
          { active, push: (message) => messages.push(message) }
        )
      )

      expect(session?.previewMessages.map((message) => message.text)).toEqual(['ask', 'ask'])
      expect(session?.firstUserPrompt).toBe(userText)
      expect(messages).toEqual(
        active
          ? [
              { role: 'user', text: userText, timestamp: null },
              { role: 'assistant', text, timestamp: null },
              {
                role: 'assistant',
                text: `${' '.repeat(2048)}\n${' '.repeat(2048)}outside preview budget`,
                timestamp: null
              }
            ]
          : []
      )
    }
  )

  it.each([5000, 256 * 1024 + 1])(
    'publishes %i-character Grok turns before preview limits',
    async (length) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-grok-transcript-'))
      tempRoots.push(root)
      const path = join(root, 'summary.json')
      await writeFile(path, JSON.stringify({ info: { id: 'grok-transcript' } }))
      const text = 'x'.repeat(length)
      await writeFile(
        join(root, 'chat_history.jsonl'),
        [
          { type: 'user', content: '<user_info>bootstrap</user_info>' },
          {
            type: 'user',
            content: `<user_info>hidden</user_info><user_query>${text}</user_query>`
          },
          { type: 'assistant', content: text },
          { type: 'assistant', content: [{ type: 'text', text }] }
        ]
          .map((line) => JSON.stringify(line))
          .join('\n')
      )
      const messages: TranscriptMessage[] = []
      const session = await parseGrokSessionFile(
        { path, mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00.000Z' },
        'linux',
        { active: true, push: (message) => messages.push(message) }
      )
      expect(messages).toEqual(
        ['user', 'assistant', 'assistant'].map((role) => ({
          role,
          text: text.slice(0, 256 * 1024),
          timestamp: null,
          ...(length > 256 * 1024 ? { textTruncated: true } : {})
        }))
      )
      expect(session?.previewMessages.map((message) => message.text.length)).toEqual([
        220, 220, 220
      ])
    }
  )

  it('stores the unwrapped user_query as firstUserPrompt under full capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-grok-first-'))
    tempRoots.push(root)
    const sessionDir = join(root, 'session-1')
    await mkdir(sessionDir, { recursive: true })
    const summaryPath = join(sessionDir, 'summary.json')
    await writeFile(
      summaryPath,
      JSON.stringify({
        info: { id: 'session-1', cwd: '/repo/app' },
        generated_title: 'Grok title',
        created_at: '2026-05-01T10:00:00.000Z',
        updated_at: '2026-05-01T10:05:00.000Z'
      })
    )
    const realAsk = 'fix i18n keep ko workspace worktree and primary'
    await writeFile(
      join(sessionDir, 'chat_history.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          content: [
            {
              type: 'text',
              text: [
                '<user_info>',
                'OS Version: macos',
                'Shell: /opt/homebrew/bin/bash',
                'Workspace Path: /Users/ada/repo',
                "Today's date: 2026-08-01",
                'Note: Prefer using relative paths over absolute paths as tool call args when possible.',
                '</user_info>',
                `<user_query>\n${realAsk}\n</user_query>`
              ].join('\n')
            }
          ],
          timestamp: '2026-05-01T10:00:01.000Z'
        }),
        JSON.stringify({
          type: 'assistant',
          content: 'On it.',
          timestamp: '2026-05-01T10:00:02.000Z'
        })
      ].join('\n')
    )

    const session = await withFullFirstUserPromptCapture(() =>
      parseGrokSessionFile({
        path: summaryPath,
        mtimeMs: Date.now(),
        modifiedAt: new Date().toISOString()
      })
    )

    expect(session?.firstUserPrompt).toBe(realAsk)
    expect(session?.firstUserPrompt).not.toContain('user_info')
    expect(session?.firstUserPrompt).not.toContain('OS Version')
  })
})
