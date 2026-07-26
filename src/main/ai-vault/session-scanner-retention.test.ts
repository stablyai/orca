import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_VAULT_SESSION_ID_MAX_UTF8_BYTES } from './session-list-retention'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local AI Vault result retention', () => {
  it('omits a resume-critical overflow and surfaces a bounded scan issue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-vault-result-retention-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = 'x'.repeat(AI_VAULT_SESSION_ID_MAX_UTF8_BYTES + 1)
    await writeJsonlFile(join(roots.claudeProjectsDir, 'repo', 'session.jsonl'), [
      {
        type: 'user',
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/repo',
        message: { role: 'user', content: 'Retain safely' }
      }
    ])

    const result = await scanAiVaultSessions(roots)

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: join(roots.claudeProjectsDir, 'repo', 'session.jsonl'),
        message: expect.stringContaining('session id exceeds the 65536 byte limit')
      })
    ])
  })
})
