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

describe('managed Kimi session discovery', () => {
  it('indexes Kimi sessions from an additional managed home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-kimi-managed-'))
    tempRoots.push(root)
    const managedSessionsDir = join(root, 'managed-kimi-home', 'sessions')
    const sessionDir = join(managedSessionsDir, 'wd_repo_hash', 'session_managed-kimi')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-08-08T10:00:00.000Z',
        updatedAt: '2026-08-08T10:00:01.000Z',
        title: 'Managed Kimi session'
      })
    )

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      additionalKimiSessionsDirs: [managedSessionsDir]
    })

    expect(result.sessions).toEqual([
      expect.objectContaining({ agent: 'kimi', sessionId: 'session_managed-kimi' })
    ])
  })
})
