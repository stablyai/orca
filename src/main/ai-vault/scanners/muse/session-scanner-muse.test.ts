import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import {
  isolatedScanRoots,
  writeMuseScannerFixture
} from '../../scanner-fixtures/session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions muse', () => {
  it('indexes Muse envelopes with title, model, tokens, and resume command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-muse-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionFile = await writeMuseScannerFixture(roots.museSessionsDir)

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    const session = result.sessions[0]
    expect(session.agent).toBe('muse')
    expect(session.sessionId).toBe('muse-session')
    expect(session.title).toBe('Muse vault title')
    expect(session.cwd).toBe('/tmp/muse')
    expect(session.model).toBe('muse-spark-test')
    expect(session.totalTokens).toBe(15)
    expect(session.messageCount).toBe(2)
    expect(session.filePath).toBe(sessionFile)
    expect(session.resumeCommand).toBe("cd '/tmp/muse' && muse resume 'muse-session'")
  })
})
