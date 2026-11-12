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
})
