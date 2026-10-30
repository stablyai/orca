import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('Cline AI Vault sessions', () => {
  it('indexes one manifest-backed session without surfacing its messages file as a phantom', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-cline-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = '1786466194549_xrzrl'
    const sessionDir = join(roots.clineSessionsDir, sessionId)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        version: 1,
        session_id: sessionId,
        source: 'cli',
        started_at: '2026-08-11T16:36:34.551Z',
        status: 'idle',
        interactive: true,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        cwd: '/repo/cline',
        workspace_root: '/repo/cline'
      })
    )
    await writeFile(
      join(sessionDir, `${sessionId}.messages.json`),
      JSON.stringify({
        version: 1,
        updated_at: '2026-08-11T16:38:00.000Z',
        agent: 'lead',
        sessionId,
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Fix the Cline vault scanner' }]
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'I will inspect the scanner.' }],
            ts: 1_786_466_280_000,
            modelInfo: { id: 'deepseek-v4-flash', provider: 'deepseek' }
          }
        ]
      })
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.filter((session) => session.agent === 'cline')).toHaveLength(1)
    expect(result.sessions.find((session) => session.agent === 'cline')).toMatchObject({
      sessionId,
      title: 'Fix the Cline vault scanner',
      cwd: '/repo/cline',
      model: 'deepseek-v4-flash',
      messageCount: 2,
      resumeCommand: `cd '/repo/cline' && cline --id '${sessionId}'`,
      filePath: join(sessionDir, `${sessionId}.json`)
    })

    await writeFile(
      join(sessionDir, `${sessionId}.messages.json`),
      JSON.stringify({
        version: 1,
        updated_at: '2026-08-11T16:39:00.000Z',
        sessionId,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Fix the Cline vault scanner' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'I inspected the scanner.' }] },
          { role: 'user', content: [{ type: 'text', text: 'Add the regression test too' }] }
        ]
      })
    )

    const rescanned = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(rescanned.sessions.find((session) => session.agent === 'cline')).toMatchObject({
      messageCount: 3,
      updatedAt: '2026-08-11T16:39:00.000Z'
    })
  })

  it('only indexes manifests directly beneath a session directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-cline-nested-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = 'direct-session'
    const nestedId = 'nested-session'
    await mkdir(join(roots.clineSessionsDir, sessionId), { recursive: true })
    await mkdir(join(roots.clineSessionsDir, 'workspace', nestedId), { recursive: true })
    const metadata = JSON.stringify({ session_id: sessionId, cwd: '/repo' })
    await writeFile(join(roots.clineSessionsDir, sessionId, `${sessionId}.json`), metadata)
    await writeFile(
      join(roots.clineSessionsDir, 'workspace', nestedId, `${nestedId}.json`),
      JSON.stringify({ session_id: nestedId, cwd: '/unexpected' })
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.sessions.filter((session) => session.agent === 'cline')).toHaveLength(1)
    expect(result.sessions.find((session) => session.agent === 'cline')?.sessionId).toBe(sessionId)
  })
})
