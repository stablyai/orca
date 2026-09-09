import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeMusecodeScannerFixture } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions musecode', () => {
  it('indexes MuseCode envelopes with title, model, tokens, and resume command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-musecode-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionFile = await writeMusecodeScannerFixture(roots.musecodeSessionsDir)

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    const session = result.sessions[0]
    expect(session.agent).toBe('musecode')
    expect(session.sessionId).toBe('musecode-session')
    expect(session.title).toBe('Musecode vault title')
    expect(session.cwd).toBe('/tmp/musecode')
    expect(session.model).toBe('muse-spark-test')
    expect(session.totalTokens).toBe(15)
    expect(session.messageCount).toBe(2)
    expect(session.filePath).toBe(sessionFile)
    expect(session.resumeCommand).toBe("cd '/tmp/musecode' && muse resume 'musecode-session'")
  })
})
