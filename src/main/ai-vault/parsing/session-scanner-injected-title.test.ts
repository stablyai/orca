import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from '../session-scanner'
import { withFullFirstUserPromptCapture } from '../prompts/session-scanner-first-user-prompt-capture'
import { isolatedScanRoots, jsonLines } from '../scanner-fixtures/session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions harness-injected title seeding', () => {
  it('uses Claude last-prompt metadata instead of injected and tool-result user records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-last-prompt-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })

    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'last-prompt.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'last-prompt',
          timestamp: '2026-06-11T10:00:00.000Z',
          cwd: '/repo/app',
          isMeta: true,
          message: { role: 'user', content: 'Base directory for this skill: /tmp/skills' }
        },
        {
          type: 'last-prompt',
          sessionId: 'last-prompt',
          lastPrompt: 'Fix the zoom behavior in a separate PR'
        },
        {
          type: 'user',
          sessionId: 'last-prompt',
          timestamp: '2026-06-11T10:00:01.000Z',
          cwd: '/repo/app',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'src/main/window.ts was updated' }]
          }
        }
      ])
    )

    // Enable full capture so an undefined first prompt proves exclusion rather than disabled capture.
    const result = await withFullFirstUserPromptCapture(() =>
      scanAiVaultSessions({
        ...roots,
        platform: 'darwin'
      })
    )

    expect(result.issues).toEqual([])
    expect(result.sessions[0]?.lastUserPrompt).toBe('Fix the zoom behavior in a separate PR')
    expect(result.sessions[0]?.firstUserPrompt).toBeUndefined()
  })
})
