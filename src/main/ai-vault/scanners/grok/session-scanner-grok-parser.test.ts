import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withFullFirstUserPromptCapture } from '../../prompts/session-scanner-first-user-prompt-capture'
import { parseGrokSessionFile } from './session-scanner-grok-parser'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('AI Vault Grok session parser', () => {
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
