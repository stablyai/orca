import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots } from '../../scanner-fixtures/session-scanner-test-fixtures'
import {
  writeDshForkFixture,
  writeDshGenerationFixture,
  writeDshScannerFixture,
  writeDshSubagentFixture
} from './session-scanner-dsh-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions dsh', () => {
  it('indexes a v4 session across zstd frames and hides its subagent log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-dsh-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionFile = await writeDshScannerFixture(roots.dshSessionsDir)
    await writeDshSubagentFixture(roots.dshSessionsDir)

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux', limit: 20 })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    const session = result.sessions[0]
    expect(session.agent).toBe('dsh')
    expect(session.sessionId).toBe('dsh-session')
    expect(session.title).toBe('Dsh vault title')
    expect(session.cwd).toBe('/tmp/dsh')
    expect(session.model).toBe('dsh-test-model')
    expect(session.totalTokens).toBe(15)
    expect(session.messageCount).toBe(2)
    expect(session.filePath).toBe(sessionFile)
    expect(session.resumeCommand).toBe(
      "cd '/tmp/dsh' && dsh-tui --backend=dsh --resume 'dsh-session'"
    )
  })

  it('reads the newest generation per directory and keeps ordinary forks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-dsh-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const newest = await writeDshGenerationFixture(roots.dshSessionsDir)
    await writeDshForkFixture(roots.dshSessionsDir)

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux', limit: 20 })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual([
      'dsh-fork',
      'dsh-gen'
    ])
    const generation = result.sessions.find((session) => session.sessionId === 'dsh-gen')
    expect(generation?.title).toBe('Dsh generation 5')
    expect(generation?.filePath).toBe(newest)
  })
})
