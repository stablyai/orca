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

describe('scanAiVaultSessions Grok managed accounts', () => {
  it('discovers Grok summary sessions from additional managed homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-grok-managed-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const managedSessionsDir = join(root, 'managed-grok-home', 'sessions')
    await mkdir(join(managedSessionsDir, encodeURIComponent('/tmp/managed-grok'), 'managed'), {
      recursive: true
    })
    await writeFile(
      join(managedSessionsDir, encodeURIComponent('/tmp/managed-grok'), 'managed', 'summary.json'),
      JSON.stringify({
        info: { id: 'managed', cwd: '/tmp/managed-grok' },
        history: [{ role: 'user', content: 'managed grok prompt' }],
        current_model_id: 'grok-build'
      })
    )

    const result = await scanAiVaultSessions({
      ...roots,
      additionalGrokSessionsDirs: [managedSessionsDir],
      platform: 'darwin'
    })

    expect(result.sessions.some((session) => session.agent === 'grok')).toBe(true)
    expect(result.sessions.some((session) => session.sessionId === 'managed')).toBe(true)
  })
})
