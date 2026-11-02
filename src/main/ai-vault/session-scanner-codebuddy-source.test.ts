import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions — CodeBuddy transcripts', () => {
  it('discovers ~/.codebuddy/projects transcripts and attributes them to codebuddy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codebuddy-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.codebuddyProjectsDir, 'project'), { recursive: true })

    await writeFile(
      join(roots.codebuddyProjectsDir, 'project', 'codebuddy-session.jsonl'),
      jsonLines([
        {
          id: 'cb-msg-1',
          timestamp: 1_777_634_400_000,
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'fix the flaky test' }],
          sessionId: 'codebuddy-session',
          cwd: '/repo/app'
        },
        {
          id: 'cb-msg-2',
          timestamp: 1_777_634_405_000,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'On it' }],
          providerData: { model: 'glm-5.3-flash' },
          sessionId: 'codebuddy-session',
          cwd: '/repo/app'
        },
        {
          id: 'cb-title-1',
          timestamp: 1_777_634_406_000,
          type: 'ai-title',
          aiTitle: 'Fixing the flaky test',
          sessionId: 'codebuddy-session',
          cwd: '/repo/app'
        },
        {
          id: 'cb-summary-1',
          timestamp: 1_777_634_407_000,
          type: 'summary',
          summary: 'Fix the flaky test',
          providerData: { source: 'initial-user-message' }
        }
      ])
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    const codebuddy = result.sessions.find((session) => session.agent === 'codebuddy')
    expect(codebuddy).toMatchObject({
      sessionId: 'codebuddy-session',
      cwd: '/repo/app',
      title: 'Fix the flaky test',
      model: 'glm-5.3-flash',
      resumeCommand: "cd '/repo/app' && codebuddy --resume 'codebuddy-session'",
      filePath: join(roots.codebuddyProjectsDir, 'project', 'codebuddy-session.jsonl')
    })
    expect(codebuddy?.messageCount).toBe(2)
    expect(codebuddy?.previewMessages.map((message) => message.text)).toEqual([
      'fix the flaky test',
      'On it'
    ])
  })
})
