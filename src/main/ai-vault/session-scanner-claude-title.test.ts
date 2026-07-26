import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions Claude title selection', () => {
  it('prefers the latest generated ai-title over the first user prompt, but a custom-title wins over both', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-ai-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, 'project')

    await writeJsonlFile(join(projectDir, 'generated.jsonl'), [
      {
        type: 'user',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'First user prompt' }
      },
      {
        type: 'ai-title',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:01:00.000Z',
        aiTitle: 'Understanding karma and moral accountability'
      },
      {
        type: 'ai-title',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:02:00.000Z',
        aiTitle: 'Updated karma discussion title'
      }
    ])
    await writeJsonlFile(join(projectDir, 'custom.jsonl'), [
      {
        type: 'user',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'First user prompt' }
      },
      {
        type: 'ai-title',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:01:00.000Z',
        aiTitle: 'Generated title that must lose'
      },
      {
        type: 'custom-title',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:02:00.000Z',
        customTitle: 'User set title'
      }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title).sort()).toEqual([
      'Updated karma discussion title',
      'User set title'
    ])
  })

  it('excludes Claude Task subagent transcripts from the session list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-subagents-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionDir = join(roots.claudeProjectsDir, 'project', 'claude-session')

    await writeJsonlFile(join(roots.claudeProjectsDir, 'project', 'claude-session.jsonl'), [
      {
        type: 'user',
        sessionId: 'claude-session',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Parent session prompt' }
      }
    ])
    await writeJsonlFile(join(sessionDir, 'subagents', 'agent-abc123.jsonl'), [
      {
        type: 'user',
        sessionId: 'claude-session',
        timestamp: '2026-05-01T10:00:05.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Subagent task prompt' }
      }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title)).toEqual(['Parent session prompt'])
  })
})
