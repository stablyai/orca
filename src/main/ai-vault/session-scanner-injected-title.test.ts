import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions harness-injected title seeding', () => {
  it('keeps harness-injected Claude turns without isMeta out of session titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-injected-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })

    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'injected-first.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'injected-first',
          timestamp: '2026-06-11T10:00:00.000Z',
          cwd: '/repo/app',
          // Task notifications carry no isMeta — only their text marks them.
          message: {
            role: 'user',
            content: '<task-notification> <task-id>abc</task-id> <status>completed</status>'
          }
        },
        {
          type: 'user',
          sessionId: 'injected-first',
          timestamp: '2026-06-11T10:00:01.000Z',
          cwd: '/repo/app',
          message: { role: 'user', content: 'Fix the sidebar label bug' }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.title).toBe('Fix the sidebar label bug')
  })

  it('titles a session from a real first turn that pastes a custom element', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-custom-element-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })

    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'custom-element-first.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'custom-element-first',
          timestamp: '2026-06-11T10:00:00.000Z',
          cwd: '/repo/app',
          // A real prompt starting with an unknown kebab tag is the user's turn;
          // it must win the title over a later prompt, not be demoted as machinery.
          message: { role: 'user', content: '<my-custom-element> render the profile card' }
        },
        {
          type: 'user',
          sessionId: 'custom-element-first',
          timestamp: '2026-06-11T10:00:01.000Z',
          cwd: '/repo/app',
          message: { role: 'user', content: 'now add a dark variant' }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.title).toBe('<my-custom-element> render the profile card')
  })

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

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions[0]?.lastUserPrompt).toBe('Fix the zoom behavior in a separate PR')
  })
})
