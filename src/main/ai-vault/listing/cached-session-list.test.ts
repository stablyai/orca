import { afterEach, describe, expect, it, vi } from 'vitest'

const { scanAiVaultSessionsInBackground } = vi.hoisted(() => ({
  scanAiVaultSessionsInBackground: vi.fn()
}))

vi.mock('../scan-service/session-scanner-background', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInBackground
}))
vi.mock('../discovery/ai-vault-scan-roots', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveLocalAiVaultScanRoots: vi.fn(async () => ({
    roots: { additionalCodexSessionsDirs: [], wslHomeDirs: [] },
    wslConfirmed: true
  }))
}))

import { listAiVaultSessions, resetAiVaultSessionListCacheForTests } from './cached-session-list'

describe('AI Vault session list cache', () => {
  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInBackground.mockReset()
  })

  it("keeps the panel's list while other readers scan other scopes", async () => {
    scanAiVaultSessionsInBackground.mockResolvedValue({ sessions: [], issues: [], scannedAt: 's' })
    const panel = { scopePaths: ['/src/r1'], includeAntigravityIdeSessions: true, limit: 1000 }
    await listAiVaultSessions(panel)
    // A plugin's unscoped read and two workspace reads.
    await listAiVaultSessions({ limit: 200 })
    await listAiVaultSessions({ limit: 200, scopePaths: ['/a'], scopeOnly: true })
    await listAiVaultSessions({ limit: 200, scopePaths: ['/b'], scopeOnly: true })
    expect(scanAiVaultSessionsInBackground).toHaveBeenCalledTimes(4)
    await listAiVaultSessions(panel)
    expect(scanAiVaultSessionsInBackground).toHaveBeenCalledTimes(4)
  })

  it('evicts the least recently used scope past four', async () => {
    scanAiVaultSessionsInBackground.mockResolvedValue({ sessions: [], issues: [], scannedAt: 's' })
    for (const scope of ['/a', '/b', '/c', '/d', '/e']) {
      await listAiVaultSessions({ scopePaths: [scope], scopeOnly: true })
    }
    await listAiVaultSessions({ scopePaths: ['/b'], scopeOnly: true })
    expect(scanAiVaultSessionsInBackground).toHaveBeenCalledTimes(5)
    await listAiVaultSessions({ scopePaths: ['/a'], scopeOnly: true })
    expect(scanAiVaultSessionsInBackground).toHaveBeenCalledTimes(6)
  })

  it('serves the refreshed list, not an older scope-only one, after a forced refresh', async () => {
    const row = (title: string) => ({ id: title, title, cwd: '/src/r1', filePath: `/t/${title}` })
    scanAiVaultSessionsInBackground.mockResolvedValueOnce({
      sessions: [row('old')],
      issues: [],
      scannedAt: 's1'
    })
    const project = { scopePaths: ['/src/r1'], scopeOnly: true }
    await listAiVaultSessions(project)
    scanAiVaultSessionsInBackground.mockResolvedValueOnce({
      sessions: [row('new')],
      issues: [],
      scannedAt: 's2'
    })
    // All, with the same scope paths, refreshed by hand.
    await listAiVaultSessions({ scopePaths: ['/src/r1'], force: true })
    const back = await listAiVaultSessions(project)
    expect(back.sessions.map((session) => session.title)).toEqual(['new'])
    expect(scanAiVaultSessionsInBackground).toHaveBeenCalledTimes(2)
  })

  it('does not cache a scan that began before a forced refresh finished', async () => {
    const row = (title: string) => ({ id: title, title, cwd: '/src/r1', filePath: `/t/${title}` })
    const slow = Promise.withResolvers<unknown>()
    const staleScanEntered = Promise.withResolvers<void>()
    scanAiVaultSessionsInBackground.mockImplementationOnce(() => {
      staleScanEntered.resolve()
      return slow.promise
    })
    const project = { scopePaths: ['/src/r1'], scopeOnly: true }
    const stale = listAiVaultSessions(project)
    // The forced refresh must reach the scanner after the stale scan did.
    await staleScanEntered.promise
    scanAiVaultSessionsInBackground.mockResolvedValueOnce({
      sessions: [row('new')],
      issues: [],
      scannedAt: 's2'
    })
    await listAiVaultSessions({ scopePaths: ['/src/r1'], force: true })
    slow.resolve({ sessions: [row('old')], issues: [], scannedAt: 's1' })
    await stale
    const back = await listAiVaultSessions(project)
    expect(back.sessions.map((session) => session.title)).toEqual(['new'])
  })
})
