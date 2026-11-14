import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import {
  isolatedScanRoots,
  writeJsonlFile
} from '../../scanner-fixtures/session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions Claude title selection', () => {
  it('prefers the latest generated ai-title over the first user prompt, but a custom-title wins over both, and marks which is a name', async () => {
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

    await writeJsonlFile(join(projectDir, 'prompt.jsonl'), [
      {
        type: 'user',
        sessionId: 'prompt',
        timestamp: '2026-05-01T12:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Unnamed session prompt' }
      }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    // Renames and generated names are the session's own; a prompt only stands in until one exists.
    expect(
      result.sessions
        .map((session) => [session.title, session.titleKind])
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
    ).toEqual([
      ['Unnamed session prompt', 'fallback'],
      ['Updated karma discussion title', 'named'],
      ['User set title', 'named']
    ])
  })
})
