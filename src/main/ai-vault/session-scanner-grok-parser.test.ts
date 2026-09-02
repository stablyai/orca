import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import { extractGrokContentText, parseGrokSessionFile } from './session-scanner-grok-parser'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('AI Vault Grok session parser', () => {
  it('extracts bounded user_query text without trimming the full body', () => {
    const trimSpy = vi.spyOn(String.prototype, 'trim')
    const result = extractGrokContentText(
      `<USER_INFO>context</USER_INFO><USER_QUERY>\n${'Grok prompt '.repeat(400)}</USER_QUERY>`
    )
    const trimCalls = trimSpy.mock.calls.length
    trimSpy.mockRestore()

    // stripGrokUserQueryEnvelope trims the body once; the fold must never trim
    // per character (the input here is 4800+ chars).
    expect(trimCalls).toBeGreaterThan(0)
    expect(trimCalls).toBeLessThan(20)
    expect(result?.startsWith('Grok prompt Grok prompt')).toBe(true)
    expect(result?.endsWith('...')).toBe(true)
    expect(result).not.toContain('USER_QUERY')
    expect(result).not.toContain('USER_INFO')
  })

  it('folds Grok array content without joining all text parts', () => {
    const result = extractGrokContentText([
      { type: 'text', text: 'Grok array '.repeat(80) },
      { type: 'text', text: 'tail' }
    ])

    expect(result?.startsWith('Grok array Grok array')).toBe(true)
    expect(result?.endsWith('...')).toBe(true)
  })

  it('drops an astral char straddling the preview scan cap instead of splitting it', () => {
    // Hidden context is skipped by the fold, so the 4096-code-unit scan cap lands
    // mid-emoji while the visible text stays well under the 220-char preview cap.
    const hidden = `<system-reminder>${'x'.repeat(4057)}</system-reminder>`
    const result = extractGrokContentText(`${hidden}ask😀tail`)

    expect(hidden).toHaveLength(4092)
    expect(result).toBe('ask')
  })

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
