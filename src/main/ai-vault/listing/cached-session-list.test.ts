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
